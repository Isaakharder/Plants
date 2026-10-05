-- Projections › Weekly Plant Data: Set → Harvest cohort columns
--
-- 1. crop_node_stages(crop): the per-node rules shared by weekly_plant_data()
--    and set_harvest_cohorts(), so the two calculations can't drift apart.
-- 2. weekly_plant_data(): unchanged signature and output; now reads its
--    per-node stage weeks from crop_node_stages().
-- 3. set_harvest_cohorts(crop, year): for each harvest week of the year, what
--    share of each earlier SetFruit cohort was first harvested that week.
--
-- All three are SECURITY INVOKER: every table is read with the caller's RLS,
-- so another organization's crop yields no rows.

-- ---------------------------------------------------------------------------
-- 1. Shared per-node stage weeks
-- ---------------------------------------------------------------------------
--
-- One row per active node of the crop that has at least one observation:
--   * a node's observations in one week are reduced to the latest one
--     (observed_at, then recorded_at, then id);
--   * set / breaker / harvested: the first week the node was recorded at that
--     stage, as yyyyww (ISO year * 100 + ISO week) and as the week's Monday;
--   * first_yw / last_yw: the node's first and last observed weeks;
--   * latest_status: its status in its most recent observed week.
-- Nodes removed in the collector (is_active = false) are ignored.

create or replace function public.crop_node_stages(p_crop_id uuid)
returns table (
  plant_node_id         uuid,
  measurement_stem_id   uuid,
  first_yw              integer,
  last_yw               integer,
  set_yw                integer,
  breaker_yw            integer,
  harvested_yw          integer,
  set_week_start        date,
  harvested_week_start  date,
  latest_status         text
)
language sql
stable
security invoker
set search_path = ''
as $$
  with node_weeks as (
    select distinct on (o.plant_node_id, o.year, o.week_number)
      o.plant_node_id,
      n.measurement_stem_id,
      o.year * 100 + o.week_number as yw,
      o.status
    from public.node_observations o
    join public.plant_nodes n on n.id = o.plant_node_id and n.is_active
    where o.crop_id = p_crop_id
    order by o.plant_node_id, o.year, o.week_number, o.observed_at desc, o.recorded_at desc, o.id desc
  ),
  per_node as (
    select
      plant_node_id,
      measurement_stem_id,
      min(yw) as first_yw,
      max(yw) as last_yw,
      min(yw) filter (where status = 'SetFruit')     as set_yw,
      min(yw) filter (where status = 'BreakerFruit') as breaker_yw,
      min(yw) filter (where status = 'Harvested')    as harvested_yw,
      (array_agg(status order by yw desc))[1]        as latest_status
    from node_weeks
    group by plant_node_id, measurement_stem_id
  )
  select
    p.plant_node_id,
    p.measurement_stem_id,
    p.first_yw,
    p.last_yw,
    p.set_yw,
    p.breaker_yw,
    p.harvested_yw,
    to_date((p.set_yw / 100) || '-' || lpad((p.set_yw % 100)::text, 2, '0'), 'IYYY-IW'),
    to_date((p.harvested_yw / 100) || '-' || lpad((p.harvested_yw % 100)::text, 2, '0'), 'IYYY-IW'),
    p.latest_status
  from per_node p
$$;

revoke execute on function public.crop_node_stages(uuid) from public, anon;
grant  execute on function public.crop_node_stages(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 2. weekly_plant_data(): same contract, shared stage weeks
-- ---------------------------------------------------------------------------
-- Rules are documented in 20261007000000_weekly_plant_data.sql. Stem spans
-- are each stem's earliest and latest observed node week, as before.

create or replace function public.weekly_plant_data(
  p_crop_id uuid,
  p_year integer,
  p_as_of timestamptz default now()
)
returns table (
  iso_week          integer,
  sampled_stems     integer,
  sampled_m2        numeric,
  new_sets          integer,
  new_breakers      integer,
  new_harvested     integer,
  sets_per_m2       numeric,
  breakers_per_m2   numeric,
  harvested_per_m2  numeric,
  is_sampled        boolean,
  is_baseline       boolean,
  is_provisional    boolean
)
language sql
stable
security invoker
set search_path = ''
as $$
  with crop as (
    select c.id, c.picking_stems::numeric / c.area_m2 as stems_per_m2
    from public.crops c
    where c.id = p_crop_id
  ),
  stage_entries as (
    select * from public.crop_node_stages((select id from crop))
  ),
  stem_spans as (
    select measurement_stem_id, min(first_yw) as first_yw, max(last_yw) as last_yw
    from stage_entries
    group by measurement_stem_id
  ),
  weeks as (
    select w as iso_week, p_year * 100 + w as yw
    from generate_series(1, public.iso_weeks_in_year(p_year)) as w
  ),
  current_week as (
    select extract(isoyear from p_as_of at time zone 'America/Toronto')::integer * 100
         + extract(week from p_as_of at time zone 'America/Toronto')::integer as yw
  ),
  per_week as (
    select
      w.iso_week,
      w.yw,
      (select count(*) from stem_spans s where w.yw between s.first_yw and s.last_yw)::integer as sampled_stems,
      (select count(*) from stage_entries e where e.set_yw = w.yw)::integer as new_sets,
      (select count(*) from stage_entries e where e.breaker_yw = w.yw)::integer as new_breakers,
      (select count(*) from stage_entries e where e.harvested_yw = w.yw)::integer as new_harvested
    from weeks w
  )
  select
    p.iso_week,
    p.sampled_stems,
    case when p.sampled_stems > 0 then p.sampled_stems / c.stems_per_m2 end,
    p.new_sets,
    p.new_breakers,
    p.new_harvested,
    case when p.sampled_stems > 0 then p.new_sets      / (p.sampled_stems / c.stems_per_m2) end,
    case when p.sampled_stems > 0 then p.new_breakers  / (p.sampled_stems / c.stems_per_m2) end,
    case when p.sampled_stems > 0 then p.new_harvested / (p.sampled_stems / c.stems_per_m2) end,
    p.sampled_stems > 0,
    coalesce(p.yw = (select min(first_yw) from stem_spans), false),
    p.yw = (select yw from current_week)
  from per_week p
  cross join crop c
  order by p.iso_week
$$;

-- ---------------------------------------------------------------------------
-- 3. set_harvest_cohorts()
-- ---------------------------------------------------------------------------
--
-- A node's set cohort is the first week it was recorded SetFruit; its delay is
-- the number of weeks from that week to the first week it was recorded
-- Harvested (Monday to Monday, so ISO-year boundaries and week 53 are exact).
-- Only harvests after the set week have a delay. Nodes never recorded SetFruit
-- belong to no cohort (reported per week as harvested_without_set).
--
-- One row per ISO week of p_year (the harvest week), in order:
--   min_delay / max_delay   the crop's observed delay range over all its
--                           history (same on every row; null when nothing
--                           has been harvested after a set)
--   harvested_total         = weekly_plant_data().new_harvested
--   harvested_in_cohorts    nodes first harvested this week, counted in cells
--   harvested_without_set   nodes first harvested this week with no SetFruit
--   cells                   one object per delay in min..max:
--     delay, set_year, set_week   the cohort this cell refers to (row − delay)
--     cohort_sets                 every node of that cohort (the denominator)
--     harvested                   of those, first harvested in this row's week
--     percent                     harvested ÷ cohort_sets × 100, or null (—)
--                                 when the cohort has no sets or this harvest
--                                 week wasn't sampled
--     is_baseline_cohort          the cohort is the crop's first sampled week
--     cohort_harvested / cohort_aborted / cohort_pruned / cohort_on_plant
--                                 the whole cohort's fate in the latest data:
--                                 harvested at any delay; else latest status
--                                 Aborted; Pruned; anything else = still on
--                                 the plant. They sum to cohort_sets.
-- is_sampled / is_provisional come from weekly_plant_data().

create or replace function public.set_harvest_cohorts(
  p_crop_id uuid,
  p_year integer,
  p_as_of timestamptz default now()
)
returns table (
  iso_week               integer,
  is_sampled             boolean,
  is_provisional         boolean,
  min_delay              integer,
  max_delay              integer,
  harvested_total        integer,
  harvested_in_cohorts   integer,
  harvested_without_set  integer,
  cells                  jsonb
)
language sql
stable
security invoker
set search_path = ''
as $$
  with weekly as (
    select w.iso_week, w.is_sampled, w.is_provisional, w.new_harvested,
           to_date(p_year || '-' || lpad(w.iso_week::text, 2, '0'), 'IYYY-IW') as week_start
    from public.weekly_plant_data(p_crop_id, p_year, p_as_of) w
  ),
  stages as (
    select * from public.crop_node_stages(p_crop_id)
  ),
  timed as (
    select set_week_start, harvested_week_start, (harvested_week_start - set_week_start) / 7 as delay
    from stages
    where set_week_start is not null and harvested_week_start > set_week_start
  ),
  delay_range as (
    select min(delay) as lo, max(delay) as hi from timed
  ),
  baseline as (
    select to_date((min(first_yw) / 100) || '-' || lpad((min(first_yw) % 100)::text, 2, '0'), 'IYYY-IW') as week_start
    from stages
  ),
  cohorts as (
    select
      set_week_start,
      count(*)::integer as sets,
      count(*) filter (where harvested_week_start > set_week_start)::integer as harvested,
      count(*) filter (where not coalesce(harvested_week_start > set_week_start, false) and latest_status = 'Aborted')::integer as aborted,
      count(*) filter (where not coalesce(harvested_week_start > set_week_start, false) and latest_status = 'Pruned')::integer as pruned,
      count(*) filter (where not coalesce(harvested_week_start > set_week_start, false) and latest_status not in ('Aborted', 'Pruned'))::integer as on_plant
    from stages
    where set_week_start is not null
    group by set_week_start
  ),
  pairs as (
    select set_week_start, delay, count(*)::integer as n
    from timed
    group by set_week_start, delay
  )
  select
    w.iso_week,
    w.is_sampled,
    w.is_provisional,
    r.lo,
    r.hi,
    w.new_harvested,
    (select count(*) from timed t where t.harvested_week_start = w.week_start)::integer,
    (select count(*) from stages s where s.set_week_start is null and s.harvested_week_start = w.week_start)::integer,
    coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'delay', d,
          'set_year', extract(isoyear from w.week_start - 7 * d)::integer,
          'set_week', extract(week from w.week_start - 7 * d)::integer,
          'cohort_sets', coalesce(c.sets, 0),
          'harvested', coalesce(p.n, 0),
          'percent', case when w.is_sampled and coalesce(c.sets, 0) > 0 then coalesce(p.n, 0) * 100.0 / c.sets end,
          'is_baseline_cohort', coalesce(w.week_start - 7 * d = (select week_start from baseline), false),
          'cohort_harvested', coalesce(c.harvested, 0),
          'cohort_aborted', coalesce(c.aborted, 0),
          'cohort_pruned', coalesce(c.pruned, 0),
          'cohort_on_plant', coalesce(c.on_plant, 0)
        )
        order by d
      )
      from generate_series(r.lo, r.hi) as d
      left join cohorts c on c.set_week_start = w.week_start - 7 * d
      left join pairs p on p.set_week_start = w.week_start - 7 * d and p.delay = d
    ), '[]'::jsonb)
  from weekly w
  cross join delay_range r
  order by w.iso_week
$$;

revoke execute on function public.set_harvest_cohorts(uuid, integer, timestamptz) from public, anon;
grant  execute on function public.set_harvest_cohorts(uuid, integer, timestamptz) to authenticated;
