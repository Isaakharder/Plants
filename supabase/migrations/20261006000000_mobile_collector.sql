-- Plants: mobile greenhouse collector
--
-- Hierarchy (every level belongs to one organization and one crop):
--
--   crops ── measurement_rows ── measurement_stems ─┬─ plant_nodes ── node_observations
--                                                   └─ stem_growth_measurements
--
-- Design notes
--   * IDs are generated in the browser (crypto.randomUUID) before a record is
--     queued, so replaying a queued insert after a lost response is a no-op
--     (INSERT … ON CONFLICT (id) DO NOTHING) instead of a duplicate.
--   * Every child carries organization_id and crop_id, and composite foreign
--     keys force them to match the parent's. A row can't reference another
--     organization's crop, a stem can't reference another crop's row, and so on.
--   * node_observations is append-only: each status a worker records is kept,
--     stamped with the greenhouse ISO week and the device time it was observed.
--     A node's status for a week is its latest observation in that week; its
--     current status is its latest observation overall (node_latest_statuses).
--     Projections can rebuild a fruit's set → breaker → harvest history from
--     this table later. No projection logic lives here.
--   * stem_growth_measurements holds one vegetative-growth reading per stem per
--     week (re-saving in the same week corrects it), like CropLink.
--   * Crops referenced by collector data can no longer be deleted
--     (ON DELETE RESTRICT), so recorded observations are never silently lost.

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

-- ISO years have 52 or 53 weeks; Dec 28 always falls in the last one.
create or replace function public.iso_weeks_in_year(y integer)
returns integer
language sql
immutable
strict
set search_path = ''
as $$
  select extract(week from make_date(y, 12, 28))::integer
$$;

-- Target for the composite foreign keys below. id is already unique, so this
-- adds no restriction on crops; it only lets children reference (org, id).
alter table public.crops
  add constraint crops_organization_id_id_key unique (organization_id, id);

-- ---------------------------------------------------------------------------
-- Rows
-- ---------------------------------------------------------------------------

create table public.measurement_rows (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null,
  crop_id          uuid not null,
  row_name         text not null check (char_length(btrim(row_name)) between 1 and 100),
  sort_order       integer not null default 0,
  is_active        boolean not null default true,
  created_by       uuid references auth.users (id) on delete set null default auth.uid(),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint measurement_rows_crop_fkey
    foreign key (organization_id, crop_id)
    references public.crops (organization_id, id) on delete restrict,
  constraint measurement_rows_org_crop_id_key unique (organization_id, crop_id, id)
);

create index measurement_rows_crop_idx on public.measurement_rows (crop_id, sort_order);

create trigger measurement_rows_set_updated_at
  before update on public.measurement_rows
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Stems
-- ---------------------------------------------------------------------------

create table public.measurement_stems (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     uuid not null,
  crop_id             uuid not null,
  measurement_row_id  uuid not null,
  stem_name           text not null check (char_length(btrim(stem_name)) between 1 and 100),
  sort_order          integer not null default 0,
  is_active           boolean not null default true,
  created_by          uuid references auth.users (id) on delete set null default auth.uid(),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint measurement_stems_row_fkey
    foreign key (organization_id, crop_id, measurement_row_id)
    references public.measurement_rows (organization_id, crop_id, id) on delete cascade,
  constraint measurement_stems_org_crop_id_key unique (organization_id, crop_id, id)
);

create index measurement_stems_row_idx on public.measurement_stems (measurement_row_id, sort_order);

create trigger measurement_stems_set_updated_at
  before update on public.measurement_stems
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Nodes (main-stem nodes and side shoots)
-- ---------------------------------------------------------------------------

create table public.plant_nodes (
  id                   uuid primary key default gen_random_uuid(),
  organization_id      uuid not null,
  crop_id              uuid not null,
  measurement_stem_id  uuid not null,
  node_number          integer not null check (node_number > 0),
  sort_order           integer not null default 0,
  -- Side shoots: label "<parent node>+<k>", the parent node and which side.
  is_side_shoot        boolean not null default false,
  parent_node_id       uuid,
  node_label           text check (char_length(node_label) <= 20),
  side                 text check (side in ('left', 'right')),
  is_active            boolean not null default true,
  created_by           uuid references auth.users (id) on delete set null default auth.uid(),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint plant_nodes_stem_fkey
    foreign key (organization_id, crop_id, measurement_stem_id)
    references public.measurement_stems (organization_id, crop_id, id) on delete cascade,
  constraint plant_nodes_org_crop_id_key unique (organization_id, crop_id, id),
  -- A side shoot's parent must be a node on the same stem.
  constraint plant_nodes_stem_id_key unique (measurement_stem_id, id),
  constraint plant_nodes_parent_fkey
    foreign key (measurement_stem_id, parent_node_id)
    references public.plant_nodes (measurement_stem_id, id) on delete cascade,
  constraint plant_nodes_side_shoot_shape check (
    (is_side_shoot and parent_node_id is not null and side is not null)
    or (not is_side_shoot and parent_node_id is null)
  )
);

create index plant_nodes_stem_idx on public.plant_nodes (measurement_stem_id, sort_order, node_number);
create index plant_nodes_parent_idx on public.plant_nodes (parent_node_id) where parent_node_id is not null;

create trigger plant_nodes_set_updated_at
  before update on public.plant_nodes
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Node observations (append-only status history)
-- ---------------------------------------------------------------------------

create table public.node_observations (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null,
  crop_id          uuid not null,
  plant_node_id    uuid not null,
  -- Greenhouse ISO week (America/Toronto) at the moment of observation.
  year             integer not null check (year between 2000 and 2100),
  week_number      integer not null,
  status           text not null check (status in (
                     'Aborted', 'Pruned', 'Flower', 'SetFruit', 'MatureGreen', 'BreakerFruit', 'Harvested'
                   )),
  -- Device clock when the worker tapped the status (survives offline delays).
  observed_at      timestamptz not null,
  -- Server clock when the observation reached the database.
  recorded_at      timestamptz not null default now(),
  created_by       uuid references auth.users (id) on delete set null default auth.uid(),
  constraint node_observations_node_fkey
    foreign key (organization_id, crop_id, plant_node_id)
    references public.plant_nodes (organization_id, crop_id, id) on delete cascade,
  constraint node_observations_iso_week_check
    check (week_number between 1 and public.iso_weeks_in_year(year))
);

create index node_observations_node_latest_idx
  on public.node_observations (plant_node_id, year desc, week_number desc, observed_at desc);
create index node_observations_crop_week_idx
  on public.node_observations (crop_id, year, week_number);

-- Latest observation per node, across all weeks: what the collector shows on
-- each node (a status carries forward until someone records a new one).
-- security_invoker so the caller's RLS applies to every underlying table.
create view public.node_latest_statuses
with (security_invoker = true)
as
select
  latest.id,
  latest.organization_id,
  latest.crop_id,
  latest.plant_node_id,
  n.measurement_stem_id,
  s.measurement_row_id,
  latest.year,
  latest.week_number,
  latest.status,
  latest.observed_at,
  latest.recorded_at
from public.plant_nodes n
join public.measurement_stems s on s.id = n.measurement_stem_id
cross join lateral (
  select o.*
  from public.node_observations o
  where o.plant_node_id = n.id
  order by o.year desc, o.week_number desc, o.observed_at desc, o.recorded_at desc
  limit 1
) latest;

-- ---------------------------------------------------------------------------
-- Vegetative growth (one reading per stem per week)
-- ---------------------------------------------------------------------------

create table public.stem_growth_measurements (
  id                   uuid primary key default gen_random_uuid(),
  organization_id      uuid not null,
  crop_id              uuid not null,
  measurement_stem_id  uuid not null,
  year                 integer not null check (year between 2000 and 2100),
  week_number          integer not null,
  growth_cm            numeric(6, 2) not null check (growth_cm > 0),
  -- Highest active main-stem node when the reading was taken; positions the
  -- reading on the collector's Veg column.
  top_node_number      integer check (top_node_number > 0),
  notes                text check (char_length(notes) <= 500),
  observed_at          timestamptz not null,
  created_by           uuid references auth.users (id) on delete set null default auth.uid(),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint stem_growth_measurements_stem_fkey
    foreign key (organization_id, crop_id, measurement_stem_id)
    references public.measurement_stems (organization_id, crop_id, id) on delete cascade,
  constraint stem_growth_measurements_stem_week_key unique (measurement_stem_id, year, week_number),
  constraint stem_growth_measurements_iso_week_check
    check (week_number between 1 and public.iso_weeks_in_year(year))
);

create index stem_growth_measurements_crop_week_idx
  on public.stem_growth_measurements (crop_id, year, week_number);

create trigger stem_growth_measurements_set_updated_at
  before update on public.stem_growth_measurements
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------

alter table public.measurement_rows         enable row level security;
alter table public.measurement_stems        enable row level security;
alter table public.plant_nodes              enable row level security;
alter table public.node_observations        enable row level security;
alter table public.stem_growth_measurements enable row level security;

create policy "Members can read rows"
  on public.measurement_rows for select to authenticated
  using (public.is_org_member(organization_id));
create policy "Members can create rows"
  on public.measurement_rows for insert to authenticated
  with check (public.is_org_member(organization_id));
create policy "Members can update rows"
  on public.measurement_rows for update to authenticated
  using (public.is_org_member(organization_id))
  with check (public.is_org_member(organization_id));

create policy "Members can read stems"
  on public.measurement_stems for select to authenticated
  using (public.is_org_member(organization_id));
create policy "Members can create stems"
  on public.measurement_stems for insert to authenticated
  with check (public.is_org_member(organization_id));
create policy "Members can update stems"
  on public.measurement_stems for update to authenticated
  using (public.is_org_member(organization_id))
  with check (public.is_org_member(organization_id));

create policy "Members can read nodes"
  on public.plant_nodes for select to authenticated
  using (public.is_org_member(organization_id));
create policy "Members can create nodes"
  on public.plant_nodes for insert to authenticated
  with check (public.is_org_member(organization_id));
create policy "Members can update nodes"
  on public.plant_nodes for update to authenticated
  using (public.is_org_member(organization_id))
  with check (public.is_org_member(organization_id));

-- Observations are history: read and append only.
create policy "Members can read observations"
  on public.node_observations for select to authenticated
  using (public.is_org_member(organization_id));
create policy "Members can record observations"
  on public.node_observations for insert to authenticated
  with check (public.is_org_member(organization_id));

create policy "Members can read growth"
  on public.stem_growth_measurements for select to authenticated
  using (public.is_org_member(organization_id));
create policy "Members can record growth"
  on public.stem_growth_measurements for insert to authenticated
  with check (public.is_org_member(organization_id));
create policy "Members can correct growth"
  on public.stem_growth_measurements for update to authenticated
  using (public.is_org_member(organization_id))
  with check (public.is_org_member(organization_id));

-- ---------------------------------------------------------------------------
-- Grants (explicit, so behaviour doesn't depend on project defaults)
-- ---------------------------------------------------------------------------

-- Revoke Supabase's default table privileges first so only the grants below apply
-- (in particular: no DELETE anywhere, and no UPDATE on observations).
revoke all on public.measurement_rows, public.measurement_stems, public.plant_nodes,
              public.node_observations, public.stem_growth_measurements,
              public.node_latest_statuses
  from anon, authenticated;

grant select, insert, update on public.measurement_rows         to authenticated;
grant select, insert, update on public.measurement_stems        to authenticated;
grant select, insert, update on public.plant_nodes              to authenticated;
grant select, insert         on public.node_observations        to authenticated;
grant select, insert, update on public.stem_growth_measurements to authenticated;
grant select                 on public.node_latest_statuses     to authenticated;

revoke execute on function public.iso_weeks_in_year(integer) from public, anon;
grant  execute on function public.iso_weeks_in_year(integer) to authenticated;
