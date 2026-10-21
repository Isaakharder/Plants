-- Harvestable: a same-week harvest count
--
-- Requested 2026-10-21. Employees walk the sampled plants and mark peppers
-- that are ready to pick this week. A mark is a separate, append-only record
-- next to the node's status history, never a node status:
--   * node_observations and node_latest_statuses are untouched, so a Breaker
--     stays a Breaker (its date, its photos, the Friday "Still Breaker" step,
--     new-breaker counts, cohorts, attention rules and the forecast engine all
--     read exactly what they read before);
--   * a mark belongs to the greenhouse week it was made in and counts for that
--     week only; nothing carries it into the next week, and nothing turns it
--     into Harvested;
--   * harvestable = false takes a mark back (a mis-tap). The latest record per
--     node and week wins, so tapping twice in a week still counts the pepper once.
-- Marks are not visit evidence: crop_stem_weeks() and every weekly function
-- built on it ignore them, so a midweek count can't change a week's sampled
-- stems.
-- SECURITY INVOKER throughout: every table is read with the caller's RLS.

create table public.harvestable_marks (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null,
  crop_id          uuid not null,
  plant_node_id    uuid not null,
  -- Greenhouse ISO week (America/Toronto) at the moment of the tap.
  year             integer not null check (year between 2000 and 2100),
  week_number      integer not null,
  -- false takes back an earlier mark in the same week.
  harvestable      boolean not null default true,
  observed_at      timestamptz not null,
  recorded_at      timestamptz not null default now(),
  created_by       uuid references auth.users (id) on delete set null default auth.uid(),
  constraint harvestable_marks_node_fkey
    foreign key (organization_id, crop_id, plant_node_id)
    references public.plant_nodes (organization_id, crop_id, id) on delete cascade,
  constraint harvestable_marks_iso_week_check
    check (week_number between 1 and public.iso_weeks_in_year(year))
);

create index harvestable_marks_crop_week_idx on public.harvestable_marks (crop_id, year, week_number);
create index harvestable_marks_node_idx on public.harvestable_marks (plant_node_id, year, week_number, observed_at desc);

comment on table public.harvestable_marks is
  'Append-only: a pepper marked ready to pick in a greenhouse week (harvestable = false takes it back). The latest row per node and week wins. Counts for that week only; never a node status.';

alter table public.harvestable_marks enable row level security;

create policy "Members can read harvestable marks"
  on public.harvestable_marks for select to authenticated
  using (public.is_org_member(organization_id));
create policy "Members can record harvestable marks"
  on public.harvestable_marks for insert to authenticated
  with check (public.is_org_member(organization_id));

revoke all on public.harvestable_marks from anon, authenticated;
grant select, insert on public.harvestable_marks to authenticated;

-- ---------------------------------------------------------------------------
-- weekly_harvestable(): Projections › Weekly Plant Data
-- ---------------------------------------------------------------------------
-- Per ISO week of p_year: peppers marked Harvestable that week (latest mark per
-- node and week), and how many of them were then recorded Harvested in the
-- same week. Harvested peppers are already in Harvested/m²; the client adds
-- only the remainder to a week's projection, so nothing is counted twice.

create or replace function public.weekly_harvestable(
  p_crop_id uuid,
  p_year integer
)
returns table (
  iso_week            integer,
  harvestable         integer,
  harvested_same_week integer
)
language sql
stable
security invoker
set search_path = ''
as $$
  with latest as (
    select distinct on (m.plant_node_id, m.week_number)
      m.plant_node_id, m.week_number, m.harvestable
    from public.harvestable_marks m
    where m.crop_id = p_crop_id and m.year = p_year
    order by m.plant_node_id, m.week_number, m.observed_at desc, m.recorded_at desc
  )
  select
    l.week_number,
    count(*)::integer,
    count(*) filter (where exists (
      select 1 from public.node_observations o
      where o.plant_node_id = l.plant_node_id
        and o.year = p_year and o.week_number = l.week_number
        and o.status = 'Harvested'
    ))::integer
  from latest l
  where l.harvestable
  group by l.week_number
  order by l.week_number
$$;

revoke execute on function public.weekly_harvestable(uuid, integer) from public, anon;
grant  execute on function public.weekly_harvestable(uuid, integer) to authenticated;
