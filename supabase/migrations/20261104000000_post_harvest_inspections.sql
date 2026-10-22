-- Plants: row-based harvest events and post-harvest inspections
--
-- Approved 2026-10-21 (design), not yet applied to production. Additive only:
-- no existing record, function or view is changed; node_observations, photos,
-- Harvestable marks, the weekly functions and the forecast engine read exactly
-- what they read before.
--
-- Workflow
--   1. The grower records a harvest: variety, date (optionally the time it
--      finished), the intended minimum mature-colour %, and one or more
--      greenhouse row ranges ("Rows 160–180"), each complete or partial.
--      Plants finds the sampled rows inside the ranges from their numbers
--      (greenhouse_row_number). The same row can be harvested any number of
--      times in a week; each harvest is its own event.
--   2. The employee inspects every sampled stem in the harvested rows. Each
--      fruit that was on the plant must be answered (still there: its status
--      again; removed: Harvested / Aborted / Pruned). Every answer is a normal
--      node_observations record plus a harvest_inspection_answers row tying it
--      to the harvest. "✓ All fruit checked" is a stem_visits row with the
--      harvest and all_fruit_checked = true (it also counts as the week's
--      ordinary stem check).
--   3. fruit_harvest_links() links a Harvested answer to its harvest only when
--      the stem's inspection is complete, the row was harvested completely, the
--      fruit was seen on the plant before, and no other harvest of that row
--      could have taken it ('inferred'). A person can confirm or reject a link
--      (harvest_link_reviews); 'confirmed' is never computed. Observations are
--      never changed.
--
-- Tables (append-only)
--   harvest_events              one row per version of a harvest; a correction
--                               or cancellation is a new version (replaces_id),
--                               event_id is the harvest's first version
--   harvest_event_ranges        the row ranges of each version
--   harvest_inspection_answers  an observation recorded as part of a harvest's
--                               inspection
--   harvest_link_reviews        a person's confirmation / rejection of a link
--   stem_visits                 + harvest_event_id, all_fruit_checked (null on
--                               every earlier check)
--
-- Functions (read-only, SECURITY INVOKER unless noted)
--   greenhouse_row_number(name)                    "Row 171" → 171
--   record_harvest_event(...)                      the only way to write a harvest (SECURITY DEFINER, validates)
--   harvest_events_in_effect(org, crop, as_of)     latest version of each harvest + its sampled rows
--   post_harvest_inspection_stems(crop, as_of)     per harvest and sampled stem: inspection progress
--   fruit_harvest_links(crop, as_of)               per Harvested record: candidate harvests and the link
--   stem_inventory_latest(crop, as_of)             per sampled stem: what its latest records say is on the plant
--   post_harvest_workflow_from(crop)               first ISO week (yyyyww) of the new workflow
--
-- Forecast locking: weeks from post_harvest_workflow_from() on are not locked
-- officially (the Breakers-only 85% share was calibrated on Friday
-- walkthroughs, not on post-harvest counts). A completion in such a week gets
-- a 'paused' lock job, and forecast_runs refuses the insert. Locked forecasts
-- are untouched; previews still work for comparison.

-- ---------------------------------------------------------------------------
-- Row numbers
-- ---------------------------------------------------------------------------

-- The greenhouse row number of a sampled row's name: "Row 171", "row171",
-- "R 171" or "171" → 171. Null when the name carries no single number.
create or replace function public.greenhouse_row_number(p_row_name text)
returns integer
language sql
immutable
strict
set search_path = ''
as $$
  select (regexp_match(btrim(p_row_name), '^(?:row|r)?\s*([0-9]{1,5})$', 'i'))[1]::integer
$$;

revoke execute on function public.greenhouse_row_number(text) from public, anon;
grant  execute on function public.greenhouse_row_number(text) to authenticated;

create or replace function public.harvest_history_immutable()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'Harvest history cannot be changed or deleted (%)', tg_table_name using errcode = '42501';
end;
$$;

-- ---------------------------------------------------------------------------
-- harvest_events, harvest_event_ranges
-- ---------------------------------------------------------------------------

create table public.harvest_events (
  id                  uuid primary key default gen_random_uuid(),
  -- The harvest this version belongs to: the id of its first version.
  event_id            uuid not null,
  organization_id     uuid not null,
  crop_id             uuid not null,
  harvest_date        date not null,
  -- When the harvest of these rows finished (optional; the date always counts).
  finished_at         timestamptz,
  -- The grower's intended minimum mature colour for picking. An instruction,
  -- not a measurement of the harvested fruit.
  min_colour_percent  numeric(4, 1) not null check (min_colour_percent between 0 and 100),
  harvested_kg        numeric(10, 2) check (harvested_kg >= 0),
  note                text check (char_length(note) <= 500),
  cancelled           boolean not null default false,
  -- The version this one corrects or cancels (null for the first version).
  replaces_id         uuid,
  recorded_at         timestamptz not null default now(),
  recorded_by         uuid not null,
  constraint harvest_events_crop_fkey
    foreign key (organization_id, crop_id) references public.crops (organization_id, id) on delete restrict,
  constraint harvest_events_event_fkey foreign key (event_id) references public.harvest_events (id),
  constraint harvest_events_replaces_fkey foreign key (replaces_id) references public.harvest_events (id),
  constraint harvest_events_first_version check ((replaces_id is null) = (event_id = id)),
  -- History is a single line: a version is corrected at most once.
  constraint harvest_events_replaced_once unique (replaces_id),
  constraint harvest_events_cancel_note check (not cancelled or char_length(btrim(coalesce(note, ''))) > 0)
);

create index harvest_events_crop_idx on public.harvest_events (crop_id, harvest_date);
create index harvest_events_org_idx on public.harvest_events (organization_id, harvest_date);
create index harvest_events_event_idx on public.harvest_events (event_id);

comment on table public.harvest_events is
  'Append-only: harvests of greenhouse row ranges. Each correction or cancellation is a new version (replaces_id); event_id names the harvest. min_colour_percent is the grower''s intended minimum, not the colour of the harvested fruit.';

create table public.harvest_event_ranges (
  harvest_event_version_id  uuid not null references public.harvest_events (id),
  organization_id           uuid not null,
  position                  smallint not null check (position between 1 and 20),
  from_row                  integer not null check (from_row between 1 and 99999),
  to_row                    integer not null check (to_row between 1 and 99999),
  -- complete: every plant in the range was picked; partial: only part of it.
  coverage                  text not null check (coverage in ('complete', 'partial')),
  primary key (harvest_event_version_id, position),
  constraint harvest_event_ranges_order check (from_row <= to_row)
);

comment on table public.harvest_event_ranges is
  'Append-only: the greenhouse row ranges of a harvest version (written with it by record_harvest_event).';

create trigger harvest_events_immutable before update or delete on public.harvest_events
  for each row execute function public.harvest_history_immutable();
create trigger harvest_event_ranges_immutable before update or delete on public.harvest_event_ranges
  for each row execute function public.harvest_history_immutable();

alter table public.harvest_events enable row level security;
alter table public.harvest_event_ranges enable row level security;

create policy "Members can read harvests" on public.harvest_events
  for select to authenticated using (public.is_org_member(organization_id));
create policy "Members can read harvest ranges" on public.harvest_event_ranges
  for select to authenticated using (public.is_org_member(organization_id));

-- Written only through record_harvest_event(), which validates the whole harvest.
revoke all on public.harvest_events, public.harvest_event_ranges from anon, authenticated;
grant select on public.harvest_events, public.harvest_event_ranges to authenticated;

-- ---------------------------------------------------------------------------
-- record_harvest_event(): record, correct or cancel a harvest
-- ---------------------------------------------------------------------------
--
-- p_ranges: [{"from": 160, "to": 180, "coverage": "complete"}, …] (1–20,
-- not overlapping). Rejected when:
--   * the date is before planting, after pullout or in the future (Toronto);
--   * finished_at is on another day or in the future;
--   * a sampled row of this variety has no row number (ranges can't be
--     matched to it);
--   * a range includes a sampled row of another variety growing on that date.
-- Ranges without any sampled row are accepted (the harvest is still part of
-- the calendar); the result lists the sampled rows found.
-- p_replaces_id corrects (or, with p_cancel, cancels) that version, which must
-- still be the latest: two people correcting at once can't both succeed.
-- p_id makes a retry after a lost response return the same version.

create or replace function public.record_harvest_event(
  p_crop_id             uuid,
  p_harvest_date        date,
  p_finished_at         timestamptz,
  p_min_colour_percent  numeric,
  p_ranges              jsonb,
  p_harvested_kg        numeric default null,
  p_note                text default null,
  p_replaces_id         uuid default null,
  p_cancel              boolean default false,
  p_id                  uuid default null
)
returns table (version_id uuid, event_id uuid, sampled_rows jsonb)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_crop      public.crops;
  v_user      uuid := auth.uid();
  v_prev      public.harvest_events;
  v_existing  public.harvest_events;
  v_id        uuid := coalesce(p_id, gen_random_uuid());
  v_event     uuid;
  v_today     date := (now() at time zone 'America/Toronto')::date;
  v_ranges    jsonb;
  v_norm      jsonb;
  v_bad       text;
  v_date      date := p_harvest_date;
  v_finished  timestamptz := p_finished_at;
  v_colour    numeric := p_min_colour_percent;
  v_kg        numeric := p_harvested_kg;
begin
  select * into v_crop from public.crops where id = p_crop_id;
  if v_crop.id is null or v_user is null or not public.is_org_member(v_crop.organization_id) then
    raise exception 'Variety not found' using errcode = '42501';
  end if;

  -- A retry of a version already stored: return it.
  select * into v_existing from public.harvest_events where id = v_id;
  if v_existing.id is not null then
    if v_existing.crop_id <> p_crop_id or v_existing.recorded_by <> v_user then
      raise exception 'Harvest version id already used' using errcode = '23505';
    end if;
    return query
      select e.version_id, e.event_id, e.sampled_rows
        from public.harvest_events_in_effect(v_crop.organization_id, p_crop_id, 'infinity') e
       where e.event_id = v_existing.event_id;
    return;
  end if;

  if p_replaces_id is not null then
    select * into v_prev from public.harvest_events where id = p_replaces_id for update;
    if v_prev.id is null or v_prev.crop_id <> p_crop_id then
      raise exception 'Harvest not found' using errcode = '22023';
    end if;
    if exists (select 1 from public.harvest_events r where r.replaces_id = v_prev.id) then
      raise exception 'This harvest was changed by someone else. Reload it and try again.' using errcode = '40001';
    end if;
    if v_prev.cancelled then
      raise exception 'This harvest was cancelled and can no longer be changed.' using errcode = '22023';
    end if;
    v_event := v_prev.event_id;
  elsif p_cancel then
    raise exception 'Only a recorded harvest can be cancelled' using errcode = '22023';
  else
    v_event := v_id;
  end if;

  if p_cancel then
    if char_length(btrim(coalesce(p_note, ''))) = 0 then
      raise exception 'Say why the harvest is cancelled' using errcode = '22023';
    end if;
    -- Cancelling keeps what was recorded; only the note and the flag are new.
    v_date := v_prev.harvest_date;
    v_finished := v_prev.finished_at;
    v_colour := v_prev.min_colour_percent;
    v_kg := v_prev.harvested_kg;
    select jsonb_agg(jsonb_build_object('from', r.from_row, 'to', r.to_row, 'coverage', r.coverage) order by r.position)
      into v_ranges from public.harvest_event_ranges r where r.harvest_event_version_id = v_prev.id;
  else
    v_ranges := p_ranges;
    if v_date is null then
      raise exception 'Enter the harvest date' using errcode = '22023';
    end if;
    if v_date < v_crop.planting_date or (v_crop.pullout_date is not null and v_date > v_crop.pullout_date) then
      raise exception '% is outside % (planted %, pulled out %)', v_date, v_crop.name, v_crop.planting_date, coalesce(v_crop.pullout_date::text, '—')
        using errcode = '22023';
    end if;
    if v_date > v_today then
      raise exception 'The harvest date % is in the future', v_date using errcode = '22023';
    end if;
    if v_finished is not null and ((v_finished at time zone 'America/Toronto')::date <> v_date or v_finished > now() + interval '10 minutes') then
      raise exception 'The finish time must be on the harvest date and not in the future' using errcode = '22023';
    end if;
    if v_colour is null or v_colour < 0 or v_colour > 100 then
      raise exception 'Enter the minimum mature colour (0–100%%)' using errcode = '22023';
    end if;
    if v_kg is not null and v_kg < 0 then
      raise exception 'Harvested kg can''t be negative' using errcode = '22023';
    end if;
    if p_note is not null and char_length(p_note) > 500 then
      raise exception 'The note is too long (500 characters at most)' using errcode = '22023';
    end if;
  end if;

  -- Ranges: shape, order, no overlap.
  if v_ranges is null or jsonb_typeof(v_ranges) <> 'array' or jsonb_array_length(v_ranges) not between 1 and 20 then
    raise exception 'Enter between 1 and 20 row ranges' using errcode = '22023';
  end if;
  -- Normalised as [{"p": position, "f": from, "t": to, "c": coverage}].
  begin
    select jsonb_agg(jsonb_build_object('p', r.ord, 'f', (r.v ->> 'from')::integer, 't', (r.v ->> 'to')::integer, 'c', r.v ->> 'coverage') order by r.ord)
      into v_norm
      from jsonb_array_elements(v_ranges) with ordinality as r(v, ord);
  exception when invalid_text_representation or numeric_value_out_of_range or cannot_coerce then
    raise exception 'Row ranges must be whole row numbers' using errcode = '22023';
  end;
  select format('Rows %s–%s', coalesce(h.f::text, '?'), coalesce(h.t::text, '?')) into v_bad
    from jsonb_to_recordset(v_norm) as h(p integer, f integer, t integer, c text)
   where h.f is null or h.t is null or h.f < 1 or h.t > 99999 or h.f > h.t or h.c is null or h.c not in ('complete', 'partial')
   limit 1;
  if found then
    raise exception '% is not a valid range (from ≤ to, complete or partial)', v_bad using errcode = '22023';
  end if;
  select format('Rows %s–%s and %s–%s overlap', a.f, a.t, b.f, b.t) into v_bad
    from jsonb_to_recordset(v_norm) as a(p integer, f integer, t integer, c text)
    join jsonb_to_recordset(v_norm) as b(p integer, f integer, t integer, c text) on a.p < b.p and a.f <= b.t and b.f <= a.t
   limit 1;
  if found then
    raise exception '%', v_bad using errcode = '22023';
  end if;

  if not p_cancel then
    -- The variety's own numbering: every sampled row must carry a number.
    select string_agg(r.row_name, ', ' order by r.row_name) into v_bad
      from public.measurement_rows r
     where r.crop_id = p_crop_id and r.is_active and public.greenhouse_row_number(r.row_name) is null;
    if v_bad is not null then
      raise exception 'These sampled rows of % have no row number, so ranges can''t be matched to them: %. Rename them (e.g. "Row 171") first.', v_crop.name, v_bad
        using errcode = '22023';
    end if;

    -- … and no range may include a sampled row of another variety growing then.
    select format('Row %s is a sampled row of %s', public.greenhouse_row_number(r.row_name), c.name) into v_bad
      from public.measurement_rows r
      join public.crops c on c.id = r.crop_id
      join jsonb_to_recordset(v_norm) as h(p integer, f integer, t integer, c text)
        on public.greenhouse_row_number(r.row_name) between h.f and h.t
     where r.organization_id = v_crop.organization_id and r.crop_id <> p_crop_id and r.is_active
       and c.planting_date <= v_date and (c.pullout_date is null or c.pullout_date >= v_date)
     order by public.greenhouse_row_number(r.row_name)
     limit 1;
    if found then
      raise exception '%, not %. Check the ranges.', v_bad, v_crop.name using errcode = '22023';
    end if;
  end if;

  insert into public.harvest_events
    (id, event_id, organization_id, crop_id, harvest_date, finished_at, min_colour_percent, harvested_kg, note, cancelled, replaces_id, recorded_by)
  values
    (v_id, v_event, v_crop.organization_id, p_crop_id, v_date, v_finished, v_colour, v_kg, nullif(btrim(coalesce(p_note, '')), ''), p_cancel, p_replaces_id, v_user);
  insert into public.harvest_event_ranges (harvest_event_version_id, organization_id, position, from_row, to_row, coverage)
    select v_id, v_crop.organization_id, h.p, h.f, h.t, h.c from jsonb_to_recordset(v_norm) as h(p integer, f integer, t integer, c text);

  return query
    select e.version_id, e.event_id, e.sampled_rows
      from public.harvest_events_in_effect(v_crop.organization_id, p_crop_id, 'infinity') e
     where e.event_id = v_event;
end;
$$;

-- ---------------------------------------------------------------------------
-- harvest_events_in_effect(): the latest version of each harvest
-- ---------------------------------------------------------------------------
--
-- Versions recorded by p_as_of only. Cancelled harvests are returned with
-- cancelled = true (callers leave them out). sampled_rows: the variety's
-- active sampled rows whose number lies in a range, with that range's
-- coverage. starts_at / ends_at: when the harvest can have happened (the
-- Toronto day, ending at finished_at when it is known).

create or replace function public.harvest_events_in_effect(
  p_organization_id uuid,
  p_crop_id uuid default null,
  p_as_of timestamptz default now()
)
returns table (
  event_id            uuid,
  version_id          uuid,
  crop_id             uuid,
  harvest_date        date,
  finished_at         timestamptz,
  starts_at           timestamptz,
  ends_at             timestamptz,
  min_colour_percent  numeric,
  harvested_kg        numeric,
  note                text,
  cancelled           boolean,
  versions            integer,
  first_recorded_at   timestamptz,
  first_recorded_by   uuid,
  recorded_at         timestamptz,
  recorded_by         uuid,
  ranges              jsonb,
  sampled_rows        jsonb
)
language sql
stable
security invoker
set search_path = ''
as $$
  with v as (
    select e.*
      from public.harvest_events e
     where e.organization_id = p_organization_id
       and (p_crop_id is null or e.crop_id = p_crop_id)
       and e.recorded_at <= p_as_of
  ),
  latest as (
    select v.* from v
     where not exists (select 1 from v r where r.replaces_id = v.id)
  )
  select
    l.event_id,
    l.id,
    l.crop_id,
    l.harvest_date,
    l.finished_at,
    l.harvest_date::timestamp at time zone 'America/Toronto',
    coalesce(l.finished_at, (l.harvest_date + 1)::timestamp at time zone 'America/Toronto'),
    l.min_colour_percent,
    l.harvested_kg,
    l.note,
    l.cancelled,
    (select count(*)::integer from v x where x.event_id = l.event_id),
    f.recorded_at,
    f.recorded_by,
    l.recorded_at,
    l.recorded_by,
    coalesce((select jsonb_agg(jsonb_build_object('from', r.from_row, 'to', r.to_row, 'coverage', r.coverage) order by r.position)
                from public.harvest_event_ranges r where r.harvest_event_version_id = l.id), '[]'::jsonb),
    coalesce((select jsonb_agg(jsonb_build_object('row_id', m.id, 'row_name', m.row_name, 'row_number', public.greenhouse_row_number(m.row_name), 'coverage', r.coverage)
                               order by public.greenhouse_row_number(m.row_name))
                from public.harvest_event_ranges r
                join public.measurement_rows m
                  on m.crop_id = l.crop_id and m.is_active
                 and public.greenhouse_row_number(m.row_name) between r.from_row and r.to_row
               where r.harvest_event_version_id = l.id), '[]'::jsonb)
  from latest l
  join public.harvest_events f on f.id = l.event_id
  order by l.harvest_date desc, f.recorded_at desc
$$;

revoke execute on function public.harvest_events_in_effect(uuid, uuid, timestamptz) from public, anon;
grant  execute on function public.harvest_events_in_effect(uuid, uuid, timestamptz) to authenticated;
revoke execute on function public.record_harvest_event(uuid, date, timestamptz, numeric, jsonb, numeric, text, uuid, boolean, uuid) from public, anon;
grant  execute on function public.record_harvest_event(uuid, date, timestamptz, numeric, jsonb, numeric, text, uuid, boolean, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Inspections: stem_visits + harvest, and the answers
-- ---------------------------------------------------------------------------

alter table public.stem_visits
  add column harvest_event_id uuid references public.harvest_events (id),
  add column all_fruit_checked boolean,
  add constraint stem_visits_inspection_shape check (
    (harvest_event_id is null and all_fruit_checked is null)
    or (harvest_event_id is not null and all_fruit_checked is not null and (checked or not all_fruit_checked))
  );

create index stem_visits_harvest_idx on public.stem_visits (harvest_event_id, measurement_stem_id) where harvest_event_id is not null;

comment on column public.stem_visits.harvest_event_id is
  'Post-harvest inspection: the harvest (its event_id) this check belongs to. Null for ordinary checks and every check made before 2026-10-21.';
comment on column public.stem_visits.all_fruit_checked is
  'Post-harvest inspection: true when every fruit on the stem was answered ("✓ All fruit checked"); false takes it back.';

create table public.harvest_inspection_answers (
  -- One observation answers at most one inspection.
  node_observation_id  uuid primary key references public.node_observations (id) on delete cascade,
  harvest_event_id     uuid not null references public.harvest_events (id),
  organization_id      uuid not null,
  crop_id              uuid not null,
  recorded_at          timestamptz not null default now(),
  created_by           uuid references auth.users (id) on delete set null default auth.uid()
);

create index harvest_inspection_answers_event_idx on public.harvest_inspection_answers (harvest_event_id);
create index harvest_inspection_answers_crop_idx on public.harvest_inspection_answers (crop_id);

comment on table public.harvest_inspection_answers is
  'Append-only: a node observation recorded as an answer in a harvest''s post-harvest inspection (the fruit is still there, or was removed).';

-- The harvest must be an event (its first version) of the same variety, and
-- the answer's observation must belong to that variety too.
create or replace function public.post_harvest_inspection_check()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (select 1 from public.harvest_events e
                  where e.id = new.harvest_event_id and e.event_id = e.id
                    and e.crop_id = new.crop_id and e.organization_id = new.organization_id) then
    raise exception 'The inspection names a harvest of another variety' using errcode = '23514';
  end if;
  -- Nested: stem_visits rows have no node_observation_id.
  if tg_table_name = 'harvest_inspection_answers' then
    if not exists (select 1 from public.node_observations o
                    where o.id = new.node_observation_id and o.crop_id = new.crop_id and o.organization_id = new.organization_id) then
      raise exception 'The answer''s observation belongs to another variety' using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;

revoke execute on function public.post_harvest_inspection_check() from public, anon, authenticated;

create trigger stem_visits_inspection_check before insert on public.stem_visits
  for each row when (new.harvest_event_id is not null) execute function public.post_harvest_inspection_check();
create trigger harvest_inspection_answers_check before insert on public.harvest_inspection_answers
  for each row execute function public.post_harvest_inspection_check();

alter table public.harvest_inspection_answers enable row level security;
create policy "Members can read inspection answers" on public.harvest_inspection_answers
  for select to authenticated using (public.is_org_member(organization_id));
create policy "Members can record inspection answers" on public.harvest_inspection_answers
  for insert to authenticated with check (public.is_org_member(organization_id));
revoke all on public.harvest_inspection_answers from anon, authenticated;
grant select on public.harvest_inspection_answers to authenticated;
-- recorded_at and created_by are the server's.
grant insert (node_observation_id, harvest_event_id, organization_id, crop_id) on public.harvest_inspection_answers to authenticated;

-- ---------------------------------------------------------------------------
-- harvest_link_reviews
-- ---------------------------------------------------------------------------

create table public.harvest_link_reviews (
  id                   uuid primary key default gen_random_uuid(),
  -- Insertion order: the latest review wins even when two share a timestamp.
  seq                  bigint generated always as identity,
  organization_id      uuid not null,
  crop_id              uuid not null,
  -- The Harvested record the review is about.
  node_observation_id  uuid not null references public.node_observations (id) on delete cascade,
  decision             text not null check (decision in ('confirmed', 'rejected', 'unreviewed')),
  -- confirmed: the harvest (event_id) the fruit was picked in.
  harvest_event_id     uuid references public.harvest_events (id),
  note                 text check (char_length(note) <= 1000),
  -- The link as the reviewer saw it.
  link_snapshot        jsonb not null default '{}'::jsonb,
  reviewed_at          timestamptz not null default now(),
  reviewed_by          uuid not null default auth.uid(),
  constraint harvest_link_reviews_shape check ((decision = 'confirmed') = (harvest_event_id is not null))
);

create index harvest_link_reviews_obs_idx on public.harvest_link_reviews (node_observation_id, reviewed_at desc, seq desc);
create index harvest_link_reviews_crop_idx on public.harvest_link_reviews (crop_id);

comment on table public.harvest_link_reviews is
  'Append-only: a person''s decision on a fruit''s harvest link (confirmed with its harvest, rejected, or reopened). The latest per Harvested record wins.';

create or replace function public.harvest_link_reviews_check()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (select 1 from public.node_observations o
                  where o.id = new.node_observation_id and o.status = 'Harvested'
                    and o.crop_id = new.crop_id and o.organization_id = new.organization_id) then
    raise exception 'Only a Harvested record of this variety can be reviewed' using errcode = '23514';
  end if;
  if new.harvest_event_id is not null
     and not exists (select 1 from public.harvest_events e
                      where e.id = new.harvest_event_id and e.event_id = e.id and e.crop_id = new.crop_id) then
    raise exception 'The confirmed harvest belongs to another variety' using errcode = '23514';
  end if;
  return new;
end;
$$;

revoke execute on function public.harvest_link_reviews_check() from public, anon, authenticated;

create trigger harvest_link_reviews_check before insert on public.harvest_link_reviews
  for each row execute function public.harvest_link_reviews_check();
create trigger harvest_link_reviews_immutable before update or delete on public.harvest_link_reviews
  for each row execute function public.harvest_history_immutable();

alter table public.harvest_link_reviews enable row level security;
create policy "Members can read harvest link reviews" on public.harvest_link_reviews
  for select to authenticated using (public.is_org_member(organization_id));
-- In their own name; the time is the server's.
create policy "Members can review harvest links" on public.harvest_link_reviews
  for insert to authenticated with check (public.is_org_member(organization_id) and reviewed_by = (select auth.uid()));
revoke all on public.harvest_link_reviews from anon, authenticated;
grant select on public.harvest_link_reviews to authenticated;
grant insert (id, organization_id, crop_id, node_observation_id, decision, harvest_event_id, note, link_snapshot) on public.harvest_link_reviews to authenticated;

-- ---------------------------------------------------------------------------
-- post_harvest_inspection_stems(): inspection progress per harvest and stem
-- ---------------------------------------------------------------------------
--
-- One row per harvest in effect (not cancelled) and active sampled stem in
-- its rows. For each:
--   to_confirm   fruit on the plant before the inspection: active nodes whose
--                latest record outside this inspection (before it was
--                completed) is SetFruit, MatureGreen or BreakerFruit
--   answered     of those, answered in this inspection
--   unanswered   to_confirm − answered
--   new_nodes    nodes answered in this inspection that weren't to confirm
--                (fruit or flowers first recorded during the inspection)
--   harvested    answers recorded as Harvested
--   state        not_started | in_progress | complete | retracted
--                complete = "✓ All fruit checked" (latest check for this
--                harvest) and nothing unanswered
--   later_harvest  another harvest of the same row that may have happened
--                after this one and before the completed check (by finish
--                time when both have one, else by date; the same date counts):
--                the answers can't be attributed to one harvest

create or replace function public.post_harvest_inspection_stems(p_crop_id uuid, p_as_of timestamptz default now())
returns table (
  event_id           uuid,
  harvest_date       date,
  measurement_row_id uuid,
  row_name           text,
  coverage           text,
  measurement_stem_id uuid,
  stem_name          text,
  state              text,
  checked_at         timestamptz,
  to_confirm         integer,
  answered           integer,
  unanswered         integer,
  new_nodes          integer,
  harvested          integer,
  later_harvest      boolean
)
language sql
stable
security invoker
set search_path = ''
as $$
  with crop as (select c.id, c.organization_id from public.crops c where c.id = p_crop_id),
  ev as (
    select e.* from crop, public.harvest_events_in_effect(crop.organization_id, crop.id, p_as_of) e where not e.cancelled
  ),
  ev_rows as (
    select e.event_id, e.harvest_date, e.finished_at, (r ->> 'row_id')::uuid as row_id, r ->> 'row_name' as row_name, r ->> 'coverage' as coverage
      from ev e cross join lateral jsonb_array_elements(e.sampled_rows) r
  ),
  ev_stems as (
    select er.*, s.id as stem_id, s.stem_name, s.sort_order
      from ev_rows er
      join public.measurement_stems s on s.measurement_row_id = er.row_id and s.is_active
  ),
  -- The latest check of each stem for each harvest.
  checks as (
    select distinct on (v.measurement_stem_id, v.harvest_event_id)
      v.measurement_stem_id, v.harvest_event_id, v.checked, v.all_fruit_checked, v.observed_at
      from public.stem_visits v
     where v.crop_id = p_crop_id and v.harvest_event_id is not null and v.recorded_at <= p_as_of
     order by v.measurement_stem_id, v.harvest_event_id, v.observed_at desc, v.recorded_at desc, v.id desc
  ),
  answers as (
    select a.harvest_event_id, o.plant_node_id, o.status, o.observed_at, o.id
      from public.harvest_inspection_answers a
      join public.node_observations o on o.id = a.node_observation_id
     where a.crop_id = p_crop_id and a.recorded_at <= p_as_of and o.recorded_at <= p_as_of
  ),
  per_stem as (
    select
      es.*,
      c.checked, c.all_fruit_checked, c.observed_at as checked_at,
      -- Nodes answered in this inspection (latest answer per node).
      (select coalesce(jsonb_object_agg(x.plant_node_id, x.status), '{}'::jsonb) from (
         select distinct on (an.plant_node_id) an.plant_node_id, an.status
           from answers an join public.plant_nodes n on n.id = an.plant_node_id and n.is_active and n.measurement_stem_id = es.stem_id
          where an.harvest_event_id = es.event_id
          order by an.plant_node_id, an.observed_at desc, an.id desc) x) as answered_nodes,
      -- Fruit on the plant before: latest record outside this inspection (up to the completed check).
      (select coalesce(jsonb_agg(x.plant_node_id), '[]'::jsonb) from (
         select n.id as plant_node_id,
                (select o.status from public.node_observations o
                  where o.plant_node_id = n.id and o.recorded_at <= p_as_of
                    and (c.observed_at is null or not c.all_fruit_checked or o.observed_at <= c.observed_at)
                    and not exists (select 1 from answers an where an.id = o.id and an.harvest_event_id = es.event_id)
                  order by o.observed_at desc, o.recorded_at desc, o.id desc limit 1) as before_status
           from public.plant_nodes n
          where n.measurement_stem_id = es.stem_id and n.is_active) x
        where x.before_status in ('SetFruit', 'MatureGreen', 'BreakerFruit')) as present_nodes
    from ev_stems es
    left join checks c on c.measurement_stem_id = es.stem_id and c.harvest_event_id = es.event_id
  ),
  counted as (
    select p.*,
      jsonb_array_length(p.present_nodes) as n_present,
      (select count(*) from jsonb_array_elements_text(p.present_nodes) x where p.answered_nodes ? x)::integer as n_answered,
      (select count(*) from jsonb_object_keys(p.answered_nodes) k where not (p.present_nodes ? k))::integer as n_new,
      (select count(*) from jsonb_each_text(p.answered_nodes) kv where kv.value = 'Harvested')::integer as n_harvested
    from per_stem p
  )
  select
    c.event_id, c.harvest_date, c.row_id, c.row_name, c.coverage, c.stem_id, c.stem_name,
    case
      when c.checked is null then case when c.answered_nodes = '{}'::jsonb then 'not_started' else 'in_progress' end
      when not c.checked then 'retracted'
      when c.all_fruit_checked and c.n_present - c.n_answered = 0 then 'complete'
      else 'in_progress'
    end,
    case when c.checked and c.all_fruit_checked then c.checked_at end,
    c.n_present, c.n_answered, c.n_present - c.n_answered, c.n_new, c.n_harvested,
    exists (
      select 1 from ev o, jsonb_array_elements(o.sampled_rows) r
       where o.event_id <> c.event_id and (r ->> 'row_id')::uuid = c.row_id
         and o.starts_at <= coalesce(case when c.checked and c.all_fruit_checked then c.checked_at end, p_as_of)
         and case when o.finished_at is not null and c.finished_at is not null then o.finished_at > c.finished_at
                  else o.harvest_date >= c.harvest_date end
    )
  from counted c
  order by c.harvest_date desc, c.event_id, c.row_name, c.sort_order, c.stem_name
$$;

revoke execute on function public.post_harvest_inspection_stems(uuid, timestamptz) from public, anon;
grant  execute on function public.post_harvest_inspection_stems(uuid, timestamptz) to authenticated;

-- ---------------------------------------------------------------------------
-- fruit_harvest_links(): which harvest took each Harvested fruit
-- ---------------------------------------------------------------------------
--
-- One row per Harvested record of an active node, from the variety's first
-- harvest in effect on (earlier records have no harvest calendar). Candidate
-- harvests: those of the node's row (any coverage) that can have happened
-- after the fruit was last seen on the plant and before the Harvested record.
-- link_status, in order:
--   confirmed / rejected     a person's latest review ('unreviewed' reopens)
--   not_from_inspection      recorded outside a post-harvest inspection
--   inspection_incomplete    the stem's inspection is not complete
--   partial_row              the row was only partly harvested
--   later_harvest            another harvest of the row before the check
--   no_earlier_record        never seen on the plant: can't be bounded
--   no_matching_harvest      the inspection's harvest can't have taken it
--                            (e.g. seen on the plant after it finished)
--   several_possible         more than one harvest could have taken it
--   inferred                 exactly that inspection's harvest
-- link_event_id / harvest_date: the inferred or confirmed harvest only.

create or replace function public.fruit_harvest_links(p_crop_id uuid, p_as_of timestamptz default now())
returns table (
  node_observation_id     uuid,
  plant_node_id           uuid,
  measurement_stem_id     uuid,
  measurement_row_id      uuid,
  harvested_at            timestamptz,
  last_on_plant_at        timestamptz,
  last_on_plant_status    text,
  inspection_event_id     uuid,
  candidate_event_ids     uuid[],
  link_status             text,
  link_event_id           uuid,
  harvest_date            date,
  reviewed_at             timestamptz,
  reviewed_by             uuid,
  review_note             text
)
language sql
stable
security invoker
set search_path = ''
as $$
  with crop as (select c.id, c.organization_id from public.crops c where c.id = p_crop_id),
  ev as (
    select e.* from crop, public.harvest_events_in_effect(crop.organization_id, crop.id, p_as_of) e where not e.cancelled
  ),
  first_harvest as (select min(starts_at) as t from ev),
  harvested as (
    select o.id, o.plant_node_id, o.observed_at, n.measurement_stem_id, s.measurement_row_id
      from public.node_observations o
      join public.plant_nodes n on n.id = o.plant_node_id and n.is_active
      join public.measurement_stems s on s.id = n.measurement_stem_id
     where o.crop_id = p_crop_id and o.status = 'Harvested' and o.recorded_at <= p_as_of
       and o.observed_at >= (select t from first_harvest)
  ),
  inspections as (select * from public.post_harvest_inspection_stems(p_crop_id, p_as_of)),
  base as (
    select
      h.*,
      lo.observed_at as last_on_plant_at,
      lo.status as last_on_plant_status,
      (select a.harvest_event_id from public.harvest_inspection_answers a where a.node_observation_id = h.id and a.recorded_at <= p_as_of) as inspection_event_id,
      coalesce((
        select array_agg(e.event_id order by e.starts_at, e.first_recorded_at)
          from ev e
         where exists (select 1 from jsonb_array_elements(e.sampled_rows) r where (r ->> 'row_id')::uuid = h.measurement_row_id)
           and e.starts_at <= h.observed_at
           and (lo.observed_at is null or e.ends_at > lo.observed_at)
      ), '{}'::uuid[]) as candidates,
      rv.decision, rv.harvest_event_id as review_event_id, rv.reviewed_at, rv.reviewed_by, rv.note as review_note
    from harvested h
    left join lateral (
      select o.observed_at, o.status from public.node_observations o
       where o.plant_node_id = h.plant_node_id and o.recorded_at <= p_as_of and o.observed_at < h.observed_at
         and o.status in ('SetFruit', 'MatureGreen', 'BreakerFruit')
       order by o.observed_at desc, o.recorded_at desc, o.id desc limit 1
    ) lo on true
    left join lateral (
      select r.* from public.harvest_link_reviews r
       where r.node_observation_id = h.id and r.reviewed_at <= p_as_of
       order by r.reviewed_at desc, r.seq desc limit 1
    ) rv on true
  ),
  decided as (
    select b.*,
      i.state as inspection_state, i.coverage, i.later_harvest,
      case
        when b.decision = 'confirmed' then 'confirmed'
        when b.decision = 'rejected' then 'rejected'
        when b.inspection_event_id is null then 'not_from_inspection'
        when i.state is distinct from 'complete' then 'inspection_incomplete'
        when i.coverage <> 'complete' then 'partial_row'
        when i.later_harvest then 'later_harvest'
        when b.last_on_plant_at is null then 'no_earlier_record'
        when not (b.inspection_event_id = any (b.candidates)) then 'no_matching_harvest'
        when b.candidates <> array[b.inspection_event_id] then 'several_possible'
        else 'inferred'
      end as status
    from base b
    left join inspections i on i.event_id = b.inspection_event_id and i.measurement_stem_id = b.measurement_stem_id
  )
  select
    d.id, d.plant_node_id, d.measurement_stem_id, d.measurement_row_id, d.observed_at,
    d.last_on_plant_at, d.last_on_plant_status, d.inspection_event_id, d.candidates, d.status,
    case d.status when 'confirmed' then d.review_event_id when 'inferred' then d.inspection_event_id end,
    (select e.harvest_date from ev e where e.event_id = case d.status when 'confirmed' then d.review_event_id when 'inferred' then d.inspection_event_id end),
    d.reviewed_at, d.reviewed_by, d.review_note
  from decided d
  order by d.observed_at desc, d.id
$$;

revoke execute on function public.fruit_harvest_links(uuid, timestamptz) from public, anon;
grant  execute on function public.fruit_harvest_links(uuid, timestamptz) to authenticated;

-- ---------------------------------------------------------------------------
-- stem_inventory_latest(): what is on each sampled stem now
-- ---------------------------------------------------------------------------
--
-- Per active sampled stem: its nodes' latest records (whatever day each was
-- made) and its latest complete post-harvest inspection. Read-only; nothing
-- here feeds the forecast.

create or replace function public.stem_inventory_latest(p_crop_id uuid, p_as_of timestamptz default now())
returns table (
  measurement_row_id    uuid,
  row_name              text,
  measurement_stem_id   uuid,
  stem_name             text,
  last_record_at        timestamptz,
  set_fruit             integer,
  mature_green          integer,
  breakers              integer,
  last_inspection_event_id uuid,
  last_inspection_at    timestamptz
)
language sql
stable
security invoker
set search_path = ''
as $$
  with latest as (
    select distinct on (o.plant_node_id) o.plant_node_id, o.status, o.observed_at
      from public.node_observations o
     where o.crop_id = p_crop_id and o.recorded_at <= p_as_of
     order by o.plant_node_id, o.observed_at desc, o.recorded_at desc, o.id desc
  ),
  done as (
    select distinct on (i.measurement_stem_id) i.measurement_stem_id, i.event_id, i.checked_at
      from public.post_harvest_inspection_stems(p_crop_id, p_as_of) i
     where i.state = 'complete'
     order by i.measurement_stem_id, i.checked_at desc
  )
  select
    r.id, r.row_name, s.id, s.stem_name,
    max(l.observed_at),
    (count(*) filter (where l.status = 'SetFruit'))::integer,
    (count(*) filter (where l.status = 'MatureGreen'))::integer,
    (count(*) filter (where l.status = 'BreakerFruit'))::integer,
    d.event_id, d.checked_at
  from public.measurement_stems s
  join public.measurement_rows r on r.id = s.measurement_row_id and r.is_active
  left join public.plant_nodes n on n.measurement_stem_id = s.id and n.is_active
  left join latest l on l.plant_node_id = n.id
  left join done d on d.measurement_stem_id = s.id
  where s.crop_id = p_crop_id and s.is_active
  group by r.id, r.row_name, r.sort_order, s.id, s.stem_name, s.sort_order, d.event_id, d.checked_at
  order by r.sort_order, r.row_name, s.sort_order, s.stem_name
$$;

revoke execute on function public.stem_inventory_latest(uuid, timestamptz) from public, anon;
grant  execute on function public.stem_inventory_latest(uuid, timestamptz) to authenticated;

-- ---------------------------------------------------------------------------
-- Forecast locking paused for the new workflow
-- ---------------------------------------------------------------------------

-- The first ISO week (year * 100 + week) of the post-harvest workflow for a
-- variety: its first harvest in effect or its first inspection check. Null
-- while it has neither.
create or replace function public.post_harvest_workflow_from(p_crop_id uuid)
returns integer
language sql
stable
security invoker
set search_path = ''
as $$
  select min(yw) from (
    select extract(isoyear from e.harvest_date)::integer * 100 + extract(week from e.harvest_date)::integer as yw
      from public.crops c, public.harvest_events_in_effect(c.organization_id, c.id, 'infinity') e
     where c.id = p_crop_id and not e.cancelled
    union all
    select v.year * 100 + v.week_number from public.stem_visits v
     where v.crop_id = p_crop_id and v.harvest_event_id is not null
  ) w
$$;

revoke execute on function public.post_harvest_workflow_from(uuid) from public, anon;
grant  execute on function public.post_harvest_workflow_from(uuid) to authenticated, service_role;

alter table public.forecast_lock_jobs drop constraint forecast_lock_jobs_status_check;
alter table public.forecast_lock_jobs add constraint forecast_lock_jobs_status_check
  check (status in ('pending', 'waiting_for_sync', 'running', 'retry', 'done', 'superseded', 'incomplete', 'failed', 'paused'));

create or replace function public.post_harvest_lock_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_from integer := public.post_harvest_workflow_from(new.crop_id);
  v_row jsonb := to_jsonb(new);
  v_yw integer;
  v_text text;
begin
  -- forecast_runs: origin_year / origin_week; forecast_lock_jobs: year / week.
  v_yw := coalesce((v_row ->> 'origin_year')::integer, (v_row ->> 'year')::integer) * 100
        + coalesce((v_row ->> 'origin_week')::integer, (v_row ->> 'week')::integer);
  if v_from is null or v_yw < v_from then
    return new;
  end if;
  v_text := format('Official forecasts are paused from %s-W%s for this variety: it uses post-harvest inspections, and the Breakers-only method has not been recalibrated for them.',
                   v_from / 100, lpad((v_from % 100)::text, 2, '0'));
  if tg_table_name = 'forecast_runs' then
    raise exception '%', v_text using errcode = '22023';
  end if;
  -- forecast_lock_jobs: queued as paused, never claimed by the worker.
  new.status := 'paused';
  new.last_error := v_text;
  return new;
end;
$$;

revoke execute on function public.post_harvest_lock_guard() from public, anon, authenticated;

create trigger forecast_lock_jobs_post_harvest_guard before insert on public.forecast_lock_jobs
  for each row execute function public.post_harvest_lock_guard();
create trigger forecast_runs_post_harvest_guard before insert on public.forecast_runs
  for each row execute function public.post_harvest_lock_guard();
