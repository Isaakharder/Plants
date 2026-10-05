-- Plants: node corrections (Plants page)
--
-- Office-side fixes for collector records, with a permanent log.
--
--   correct_node_renumber   main-stem node gets a new number (its shoots follow)
--   correct_node_shoot      side shoot: +k label, left/right, parent (same stem)
--   correct_node_remove     "Remove from plant": soft remove (is_active = false)
--   undo_node_correction    reverses one correction, as a new logged correction
--
-- Rules
--   * Nothing is ever deleted. Node ids, observations, statuses and their
--     timestamps never change; only plant_nodes' numbering/relationship
--     columns and is_active do.
--   * Every correction runs in one transaction: membership, relationships,
--     "unchanged since the panel loaded it" (updated_at of every node the
--     correction touches), validity, the change and its log entry all succeed
--     or fail together.
--   * The request id is the log entry's id, so resending a correction whose
--     response was lost returns the original entry instead of applying it twice.
--   * node_corrections is append-only: clients can read it, never write it
--     directly. Undo is a new entry pointing at the original.
--   * No unique node-number constraint: a second phone's queued offline node
--     must still be accepted. Duplicates are surfaced on the Plants page.
--
-- Also fixed here: a removed (inactive) node's side shoots could stay active
-- and keep counting in the cohort calculations. Deactivating a main node now
-- deactivates its shoots, and a shoot saved under an inactive parent (e.g. a
-- phone that was offline when the parent was removed) is stored inactive.
--
-- Direct updates of plant_nodes are narrowed to the only one the collector
-- makes: setting is_active to false (discarding a node it just created).

-- ---------------------------------------------------------------------------
-- Inactive parent ⇒ inactive shoots
-- ---------------------------------------------------------------------------

create or replace function public.plant_nodes_cascade_deactivate()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.plant_nodes
     set is_active = false
   where parent_node_id = new.id
     and is_active;
  return null;
end;
$$;

create trigger plant_nodes_cascade_deactivate
  after update of is_active on public.plant_nodes
  for each row
  when (old.is_active and not new.is_active and not new.is_side_shoot)
  execute function public.plant_nodes_cascade_deactivate();

create or replace function public.plant_nodes_shoot_follows_parent()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.is_side_shoot and new.is_active and exists (
    select 1 from public.plant_nodes p where p.id = new.parent_node_id and not p.is_active
  ) then
    new.is_active := false;
  end if;
  return new;
end;
$$;

create trigger plant_nodes_shoot_follows_parent
  before insert or update of is_active, parent_node_id on public.plant_nodes
  for each row
  when (new.is_side_shoot and new.is_active)
  execute function public.plant_nodes_shoot_follows_parent();

-- Existing data: shoots whose parent is already inactive.
update public.plant_nodes c
   set is_active = false
  from public.plant_nodes p
 where p.id = c.parent_node_id
   and c.is_active
   and not p.is_active;

-- ---------------------------------------------------------------------------
-- Direct updates: only "is_active = false"
-- ---------------------------------------------------------------------------

revoke update on public.plant_nodes from authenticated;
grant update (is_active) on public.plant_nodes to authenticated;

drop policy "Members can update nodes" on public.plant_nodes;
create policy "Members can deactivate nodes"
  on public.plant_nodes for update to authenticated
  using (public.is_org_member(organization_id))
  with check (public.is_org_member(organization_id) and not is_active);

-- ---------------------------------------------------------------------------
-- Correction log
-- ---------------------------------------------------------------------------

create table public.node_corrections (
  -- Client-generated request id: resending the same request is a no-op.
  id                       uuid primary key,
  organization_id          uuid not null,
  crop_id                  uuid not null,
  measurement_row_id       uuid not null,
  measurement_stem_id      uuid not null,
  action                   text not null check (action in ('renumber', 'correct_shoot', 'remove', 'undo')),
  -- The node the user acted on (for undo: the original correction's node).
  plant_node_id            uuid not null,
  -- Every node whose record changed.
  node_ids                 uuid[] not null check (cardinality(node_ids) > 0),
  -- Node snapshots before / after: [{id, node_number, node_label, sort_order,
  -- is_side_shoot, parent_node_id, side, is_active}], in node_ids order.
  before                   jsonb not null,
  after                    jsonb not null,
  -- Other active nodes that already shared each node's *before* identity
  -- (number, or parent + label). Undo may restore those duplicates, but no new ones.
  before_conflicts         jsonb not null default '{}'::jsonb,
  reason                   text not null check (char_length(btrim(reason)) between 3 and 500),
  undoes_correction_id     uuid references public.node_corrections (id),
  corrected_by             uuid not null,
  corrected_by_email       text,
  corrected_at             timestamptz not null default now(),
  constraint node_corrections_stem_fkey
    foreign key (organization_id, crop_id, measurement_stem_id)
    references public.measurement_stems (organization_id, crop_id, id) on delete restrict,
  constraint node_corrections_undo_shape check ((action = 'undo') = (undoes_correction_id is not null))
);

-- A correction can be undone once.
create unique index node_corrections_undo_once on public.node_corrections (undoes_correction_id)
  where undoes_correction_id is not null;
create index node_corrections_row_idx on public.node_corrections (measurement_row_id, corrected_at desc);
create index node_corrections_nodes_idx on public.node_corrections using gin (node_ids);

alter table public.node_corrections enable row level security;

create policy "Members can read corrections"
  on public.node_corrections for select to authenticated
  using (public.is_org_member(organization_id));

revoke all on public.node_corrections from anon, authenticated;
grant select on public.node_corrections to authenticated;

-- ---------------------------------------------------------------------------
-- Helpers (internal; not callable by clients)
-- ---------------------------------------------------------------------------

create or replace function public._node_snapshot(n public.plant_nodes)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_object(
    'id', n.id,
    'node_number', n.node_number,
    'node_label', n.node_label,
    'sort_order', n.sort_order,
    'is_side_shoot', n.is_side_shoot,
    'parent_node_id', n.parent_node_id,
    'side', n.side,
    'is_active', n.is_active
  )
$$;

-- Other active nodes sharing this node's identity on its stem: main nodes with
-- the same number, or shoots of the same parent with the same label.
create or replace function public._node_identity_conflicts(n jsonb, stem_id uuid, exclude uuid[])
returns uuid[]
language sql
stable
set search_path = ''
as $$
  select coalesce(array_agg(o.id order by o.id), '{}')
  from public.plant_nodes o
  where o.measurement_stem_id = stem_id
    and o.is_active
    and o.id <> all (exclude)
    and case
      when (n ->> 'is_side_shoot')::boolean then
        o.is_side_shoot
        and o.parent_node_id = (n ->> 'parent_node_id')::uuid
        and o.node_label is not distinct from (n ->> 'node_label')
      else
        not o.is_side_shoot and o.node_number = (n ->> 'node_number')::integer
    end
$$;

-- Locks the node, checks the caller may correct it, returns it.
create or replace function public._correction_node(p_node_id uuid)
returns public.plant_nodes
language plpgsql
set search_path = ''
as $$
declare
  n public.plant_nodes;
begin
  if (select auth.uid()) is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  select * into n from public.plant_nodes where id = p_node_id for update;
  if not found or not public.is_org_member(n.organization_id) then
    raise exception 'Node not found' using errcode = 'P0002';
  end if;
  return n;
end;
$$;

-- Returns an earlier entry for this request id, or null. A request id reused
-- for a different correction is an error.
create or replace function public._correction_replay(p_request_id uuid, p_action text, p_node_id uuid)
returns public.node_corrections
language plpgsql
set search_path = ''
as $$
declare
  c public.node_corrections;
begin
  if p_request_id is null then
    raise exception 'A request id is required' using errcode = '22023';
  end if;
  -- Serialise concurrent resends of the same request.
  perform pg_advisory_xact_lock(hashtextextended(p_request_id::text, 0));
  select * into c from public.node_corrections where id = p_request_id;
  if not found then
    return null;
  end if;
  if c.action <> p_action or c.plant_node_id <> p_node_id or c.corrected_by <> (select auth.uid()) then
    raise exception 'This request id was already used for a different correction' using errcode = '22023';
  end if;
  return c;
end;
$$;

create or replace function public._correction_reason(p_reason text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p_reason is null or char_length(btrim(p_reason)) < 3 then
    raise exception 'A reason is required (at least 3 characters)' using errcode = '22023';
  end if;
  if char_length(btrim(p_reason)) > 500 then
    raise exception 'The reason is too long (500 characters at most)' using errcode = '22023';
  end if;
  return btrim(p_reason);
end;
$$;

-- p_expected = {"<node id>": "<updated_at>", ...} as the panel loaded them.
-- It must name exactly the nodes this correction touches, unchanged.
create or replace function public._correction_expect(p_expected jsonb, p_ids uuid[])
returns void
language plpgsql
set search_path = ''
as $$
declare
  missing int;
begin
  if p_expected is null or jsonb_typeof(p_expected) <> 'object' then
    raise exception 'The records this correction affects changed since they were loaded. Reload and try again.' using errcode = '40001';
  end if;
  select count(*) into missing
  from (
    select id from unnest(p_ids) id
    except
    select n.id from public.plant_nodes n
    join jsonb_each_text(p_expected) e on e.key::uuid = n.id
    where n.id = any (p_ids) and n.updated_at = e.value::timestamptz
  ) x;
  if missing > 0 or (select count(*) from jsonb_object_keys(p_expected)) <> cardinality(p_ids) then
    raise exception 'The records this correction affects changed since they were loaded. Reload and try again.' using errcode = '40001';
  end if;
end;
$$;

create or replace function public._correction_log(
  p_request_id uuid,
  p_action text,
  n public.plant_nodes,
  p_node_ids uuid[],
  p_before jsonb,
  p_reason text,
  p_conflicts jsonb,
  p_undoes uuid
)
returns public.node_corrections
language plpgsql
set search_path = ''
as $$
declare
  s public.measurement_stems;
  c public.node_corrections;
begin
  select * into s from public.measurement_stems where id = n.measurement_stem_id;
  insert into public.node_corrections (
    id, organization_id, crop_id, measurement_row_id, measurement_stem_id, action, plant_node_id,
    node_ids, before, after, before_conflicts, reason, undoes_correction_id, corrected_by, corrected_by_email
  )
  values (
    p_request_id, n.organization_id, n.crop_id, s.measurement_row_id, s.id, p_action, n.id,
    p_node_ids, p_before,
    (select jsonb_agg(public._node_snapshot(x) order by array_position(p_node_ids, x.id))
       from public.plant_nodes x where x.id = any (p_node_ids)),
    coalesce(p_conflicts, '{}'::jsonb), p_reason, p_undoes,
    (select auth.uid()), (select u.email from auth.users u where u.id = (select auth.uid()))
  )
  returning * into c;
  return c;
end;
$$;

create or replace function public._snapshots(p_ids uuid[])
returns jsonb
language sql
stable
set search_path = ''
as $$
  select coalesce(jsonb_agg(public._node_snapshot(x) order by array_position(p_ids, x.id)), '[]')
  from public.plant_nodes x where x.id = any (p_ids)
$$;

create or replace function public._conflicts_of(p_ids uuid[])
returns jsonb
language sql
stable
set search_path = ''
as $$
  select coalesce(jsonb_object_agg(x.id, public._node_identity_conflicts(public._node_snapshot(x), x.measurement_stem_id, p_ids)), '{}')
  from public.plant_nodes x where x.id = any (p_ids)
$$;

-- Label "<number>+<k>" → k, or null.
create or replace function public._shoot_index(label text)
returns integer
language sql
immutable
set search_path = ''
as $$
  select (regexp_match(label, '^\d+\+(\d+)$'))[1]::integer
$$;

-- ---------------------------------------------------------------------------
-- Renumber a main-stem node (and relabel its shoots)
-- ---------------------------------------------------------------------------

create or replace function public.correct_node_renumber(
  p_request_id uuid,
  p_node_id uuid,
  p_new_number integer,
  p_reason text,
  p_expected jsonb
)
returns public.node_corrections
language plpgsql
security definer
set search_path = ''
as $$
declare
  prior public.node_corrections;
  n public.plant_nodes;
  reason text;
  ids uuid[];
  before jsonb;
  conflicts jsonb;
begin
  prior := public._correction_replay(p_request_id, 'renumber', p_node_id);
  if prior.id is not null then return prior; end if;
  reason := public._correction_reason(p_reason);
  n := public._correction_node(p_node_id);

  if n.is_side_shoot then
    raise exception 'Side shoots take their number from their parent; correct the shoot instead' using errcode = '22023';
  end if;
  if not n.is_active then
    raise exception 'This node has been removed from the plant' using errcode = '22023';
  end if;
  if p_new_number is null or p_new_number < 1 or p_new_number > 999 then
    raise exception 'Choose a node number between 1 and 999' using errcode = '22023';
  end if;
  if p_new_number = n.node_number then
    raise exception 'Node % already has that number', n.node_number using errcode = '22023';
  end if;

  -- The node and every shoot attached to it (removed shoots too, so their
  -- labels stay consistent with their parent).
  perform 1 from public.plant_nodes c where c.parent_node_id = n.id order by c.id for update;
  select array[n.id] || coalesce(array_agg(c.id order by c.id), '{}') into ids
  from public.plant_nodes c where c.parent_node_id = n.id;
  perform public._correction_expect(p_expected, ids);

  if exists (
    select 1 from public.plant_nodes o
    where o.measurement_stem_id = n.measurement_stem_id and o.is_active and not o.is_side_shoot
      and o.node_number = p_new_number and o.id <> n.id
  ) then
    raise exception 'Node % already exists on this stem', p_new_number using errcode = '23505';
  end if;

  before := public._snapshots(ids);
  conflicts := public._conflicts_of(ids);

  update public.plant_nodes
     set node_number = p_new_number,
         sort_order = case when sort_order = n.node_number then p_new_number else sort_order end
   where id = n.id;
  update public.plant_nodes c
     set node_number = p_new_number,
         sort_order = case when c.sort_order = n.node_number then p_new_number else c.sort_order end,
         node_label = case
           when public._shoot_index(c.node_label) is not null then p_new_number || '+' || public._shoot_index(c.node_label)
           else c.node_label
         end
   where c.parent_node_id = n.id;

  return public._correction_log(p_request_id, 'renumber', n, ids, before, reason, conflicts, null);
end;
$$;

-- ---------------------------------------------------------------------------
-- Correct a side shoot: +k label, side, parent (same stem)
-- ---------------------------------------------------------------------------

create or replace function public.correct_node_shoot(
  p_request_id uuid,
  p_node_id uuid,
  p_parent_node_id uuid,
  p_shoot_index integer,
  p_side text,
  p_reason text,
  p_expected jsonb
)
returns public.node_corrections
language plpgsql
security definer
set search_path = ''
as $$
declare
  prior public.node_corrections;
  n public.plant_nodes;
  parent public.plant_nodes;
  reason text;
  ids uuid[];
  label text;
  before jsonb;
  conflicts jsonb;
begin
  prior := public._correction_replay(p_request_id, 'correct_shoot', p_node_id);
  if prior.id is not null then return prior; end if;
  reason := public._correction_reason(p_reason);
  n := public._correction_node(p_node_id);

  if not n.is_side_shoot then
    raise exception 'Only side shoots can be corrected this way' using errcode = '22023';
  end if;
  if not n.is_active then
    raise exception 'This shoot has been removed from the plant' using errcode = '22023';
  end if;
  if p_side is null or p_side not in ('left', 'right') then
    raise exception 'Side must be left or right' using errcode = '22023';
  end if;
  if p_shoot_index is null or p_shoot_index < 1 or p_shoot_index > 9 then
    raise exception 'Shoot position must be +1 to +9' using errcode = '22023';
  end if;

  select * into parent from public.plant_nodes where id = p_parent_node_id for update;
  if not found or parent.measurement_stem_id <> n.measurement_stem_id then
    raise exception 'A side shoot''s parent must be a node on the same stem' using errcode = '22023';
  end if;
  if parent.is_side_shoot or not parent.is_active then
    raise exception 'The parent must be an active main-stem node' using errcode = '22023';
  end if;

  -- The shoot, plus its (new) parent when the parent changes: its number
  -- decides the label shown in the confirmation.
  ids := case when parent.id = n.parent_node_id then array[n.id] else array[n.id, parent.id] end;
  perform public._correction_expect(p_expected, ids);
  ids := array[n.id];

  label := parent.node_number || '+' || p_shoot_index;
  if parent.id = n.parent_node_id and label is not distinct from n.node_label and p_side = n.side then
    raise exception 'Nothing to change' using errcode = '22023';
  end if;
  if exists (
    select 1 from public.plant_nodes o
    where o.parent_node_id = parent.id and o.is_active and o.id <> n.id and o.node_label = label
  ) then
    raise exception 'Shoot % already exists on node %', label, parent.node_number using errcode = '23505';
  end if;

  before := public._snapshots(ids);
  conflicts := public._conflicts_of(ids);

  update public.plant_nodes
     set parent_node_id = parent.id,
         node_number = parent.node_number,
         sort_order = parent.sort_order,
         node_label = label,
         side = p_side
   where id = n.id;

  return public._correction_log(p_request_id, 'correct_shoot', n, ids, before, reason, conflicts, null);
end;
$$;

-- ---------------------------------------------------------------------------
-- Remove from plant (soft): the node and, for a main node, its shoots
-- ---------------------------------------------------------------------------

create or replace function public.correct_node_remove(
  p_request_id uuid,
  p_node_id uuid,
  p_reason text,
  p_expected jsonb
)
returns public.node_corrections
language plpgsql
security definer
set search_path = ''
as $$
declare
  prior public.node_corrections;
  n public.plant_nodes;
  reason text;
  ids uuid[];
  before jsonb;
  conflicts jsonb;
begin
  prior := public._correction_replay(p_request_id, 'remove', p_node_id);
  if prior.id is not null then return prior; end if;
  reason := public._correction_reason(p_reason);
  n := public._correction_node(p_node_id);

  if not n.is_active then
    raise exception 'This node has already been removed from the plant' using errcode = '22023';
  end if;

  perform 1 from public.plant_nodes c where c.parent_node_id = n.id order by c.id for update;
  select array[n.id] || coalesce(array_agg(c.id order by c.id), '{}') into ids
  from public.plant_nodes c where c.parent_node_id = n.id and c.is_active;
  perform public._correction_expect(p_expected, ids);

  before := public._snapshots(ids);
  conflicts := public._conflicts_of(ids);

  update public.plant_nodes set is_active = false where id = any (ids);

  return public._correction_log(p_request_id, 'remove', n, ids, before, reason, conflicts, null);
end;
$$;

-- ---------------------------------------------------------------------------
-- Undo: put every node back as it was, if nothing has changed since
-- ---------------------------------------------------------------------------

create or replace function public.undo_node_correction(
  p_request_id uuid,
  p_correction_id uuid,
  p_reason text
)
returns public.node_corrections
language plpgsql
security definer
set search_path = ''
as $$
declare
  prior public.node_corrections;
  orig public.node_corrections;
  n public.plant_nodes;
  reason text;
  snap jsonb;
  cur jsonb;
  allowed uuid[];
  now_conflicts uuid[];
begin
  select * into orig from public.node_corrections where id = p_correction_id;
  if not found or not public.is_org_member(orig.organization_id) then
    raise exception 'Correction not found' using errcode = 'P0002';
  end if;
  prior := public._correction_replay(p_request_id, 'undo', orig.plant_node_id);
  if prior.id is not null then return prior; end if;
  reason := public._correction_reason(p_reason);
  n := public._correction_node(orig.plant_node_id);

  if orig.action = 'undo' then
    raise exception 'An undo can''t be undone; make a new correction instead' using errcode = '22023';
  end if;
  -- Locks the original's row so two undos can't race past this check.
  perform 1 from public.node_corrections where id = orig.id for update;
  if exists (select 1 from public.node_corrections where undoes_correction_id = orig.id) then
    raise exception 'This correction has already been undone' using errcode = '22023';
  end if;

  perform 1 from public.plant_nodes where id = any (orig.node_ids) order by id for update;

  -- Every node must still be exactly as the correction left it.
  for snap in select * from jsonb_array_elements(orig.after) loop
    select public._node_snapshot(x) into cur from public.plant_nodes x where x.id = (snap ->> 'id')::uuid;
    if cur is distinct from snap then
      raise exception 'Can''t undo: these records have changed since this correction' using errcode = '40001';
    end if;
  end loop;

  -- Restoring must not create a duplicate that didn't exist before.
  for snap in select * from jsonb_array_elements(orig.before) loop
    continue when not (snap ->> 'is_active')::boolean;
    allowed := coalesce(array(select jsonb_array_elements_text(orig.before_conflicts -> (snap ->> 'id'))::uuid), '{}');
    now_conflicts := public._node_identity_conflicts(snap, orig.measurement_stem_id, orig.node_ids);
    if not (now_conflicts <@ allowed) then
      raise exception 'Can''t undo: another node now has %', coalesce('label ' || (snap ->> 'node_label'), 'number ' || (snap ->> 'node_number'))
        using errcode = '23505';
    end if;
    if (snap ->> 'is_side_shoot')::boolean and not exists (
      select 1 from public.plant_nodes p
      where p.id = (snap ->> 'parent_node_id')::uuid
        and (p.is_active or exists (
          select 1 from jsonb_array_elements(orig.before) b
          where (b ->> 'id')::uuid = p.id and (b ->> 'is_active')::boolean))
    ) then
      raise exception 'Can''t undo: the shoot''s parent node has been removed' using errcode = '23503';
    end if;
  end loop;

  -- Main nodes first, so shoots are restored under an active parent.
  for snap in
    select s from jsonb_array_elements(orig.before) s order by (s ->> 'is_side_shoot')::boolean
  loop
    update public.plant_nodes
       set node_number = (snap ->> 'node_number')::integer,
           node_label = snap ->> 'node_label',
           sort_order = (snap ->> 'sort_order')::integer,
           parent_node_id = (snap ->> 'parent_node_id')::uuid,
           side = snap ->> 'side',
           is_active = (snap ->> 'is_active')::boolean
     where id = (snap ->> 'id')::uuid;
  end loop;

  return public._correction_log(p_request_id, 'undo', n, orig.node_ids, orig.after, reason, public._conflicts_of(orig.node_ids), orig.id);
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

revoke execute on function public.plant_nodes_cascade_deactivate() from public, anon, authenticated;
revoke execute on function public.plant_nodes_shoot_follows_parent() from public, anon, authenticated;
revoke execute on function public._node_snapshot(public.plant_nodes) from public, anon, authenticated;
revoke execute on function public._node_identity_conflicts(jsonb, uuid, uuid[]) from public, anon, authenticated;
revoke execute on function public._correction_node(uuid) from public, anon, authenticated;
revoke execute on function public._correction_replay(uuid, text, uuid) from public, anon, authenticated;
revoke execute on function public._correction_reason(text) from public, anon, authenticated;
revoke execute on function public._correction_expect(jsonb, uuid[]) from public, anon, authenticated;
revoke execute on function public._correction_log(uuid, text, public.plant_nodes, uuid[], jsonb, text, jsonb, uuid) from public, anon, authenticated;
revoke execute on function public._snapshots(uuid[]) from public, anon, authenticated;
revoke execute on function public._conflicts_of(uuid[]) from public, anon, authenticated;
revoke execute on function public._shoot_index(text) from public, anon, authenticated;

revoke execute on function public.correct_node_renumber(uuid, uuid, integer, text, jsonb) from public, anon;
revoke execute on function public.correct_node_shoot(uuid, uuid, uuid, integer, text, text, jsonb) from public, anon;
revoke execute on function public.correct_node_remove(uuid, uuid, text, jsonb) from public, anon;
revoke execute on function public.undo_node_correction(uuid, uuid, text) from public, anon;
grant  execute on function public.correct_node_renumber(uuid, uuid, integer, text, jsonb) to authenticated;
grant  execute on function public.correct_node_shoot(uuid, uuid, uuid, integer, text, text, jsonb) to authenticated;
grant  execute on function public.correct_node_remove(uuid, uuid, text, jsonb) to authenticated;
grant  execute on function public.undo_node_correction(uuid, uuid, text) to authenticated;
