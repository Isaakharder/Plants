-- Projections › Weekly Plant Data: +0 → +12 cohort ladder and Loss
--
-- Approved 2026-10-05. Every pepper starts its own clock in the week it is first
-- recorded SetFruit (+0). A first Harvested record at +1 … +12 is a cohort
-- harvest. A pepper not resolved by the end of its +12 week is a Timeout loss
-- for cohort analysis; its raw observations are never altered, and a later
-- Harvested record still counts in weekly_plant_data()'s Harvested/m².
--
-- 1. crop_node_weeks(crop): one status per active node per week (the latest
--    observation that week). The base of every per-node rule.
-- 2. crop_node_stages(crop): unchanged output, now built on crop_node_weeks().
-- 3. set_harvest_cohorts(crop, year): replaced (new output) with fixed +0…+12
--    cells, Aborted / Pruned / Timeout / Still-on-plant counts, the closing
--    cohort's Loss, and harvested-after-timeout reconciliation.
-- weekly_plant_data() is not changed.
--
-- All SECURITY INVOKER: every table is read with the caller's RLS.

-- ---------------------------------------------------------------------------
-- 1. crop_node_weeks()
-- ---------------------------------------------------------------------------

create or replace function public.crop_node_weeks(p_crop_id uuid)
returns table (
  plant_node_id        uuid,
  measurement_stem_id  uuid,
  yw                   integer,  -- ISO year * 100 + ISO week
  week_start           date,     -- Monday of that ISO week
  status               text
)
language sql
stable
security invoker
set search_path = ''
as $$
  select distinct on (o.plant_node_id, o.year, o.week_number)
    o.plant_node_id,
    n.measurement_stem_id,
    o.year * 100 + o.week_number,
    to_date(o.year || '-' || lpad(o.week_number::text, 2, '0'), 'IYYY-IW'),
    o.status
  from public.node_observations o
  join public.plant_nodes n on n.id = o.plant_node_id and n.is_active
  where o.crop_id = p_crop_id
  order by o.plant_node_id, o.year, o.week_number, o.observed_at desc, o.recorded_at desc, o.id desc
$$;

revoke execute on function public.crop_node_weeks(uuid) from public, anon;
grant  execute on function public.crop_node_weeks(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 2. crop_node_stages(): same contract, built on crop_node_weeks()
-- ---------------------------------------------------------------------------

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
  select
    plant_node_id,
    measurement_stem_id,
    min(yw),
    max(yw),
    min(yw) filter (where status = 'SetFruit'),
    min(yw) filter (where status = 'BreakerFruit'),
    min(yw) filter (where status = 'Harvested'),
    min(week_start) filter (where status = 'SetFruit'),
    min(week_start) filter (where status = 'Harvested'),
    (array_agg(status order by yw desc))[1]
  from public.crop_node_weeks(p_crop_id)
  group by plant_node_id, measurement_stem_id
$$;

-- ---------------------------------------------------------------------------
-- 3. set_harvest_cohorts()
-- ---------------------------------------------------------------------------
--
-- Cohort = peppers first recorded SetFruit in the same week (+0).
-- Each cohort pepper resolves, for analysis, as:
--   harvested  first Harvested record at +1 … +12 (its harvest age)
--   aborted    otherwise, latest status at the end of its +12 week (or now,
--   pruned     while the window is open) is Aborted / Pruned
--   timeout    otherwise, once the window has closed
--   on_plant   otherwise (window still open)
-- A cohort's window has closed when its +12 week is over (before the current
-- greenhouse week, America/Toronto) and that week was sampled.
--
-- One row per ISO week of p_year (the harvest week H), in order:
--   harvested_total          = weekly_plant_data().new_harvested (raw)
--   harvested_in_window      cohort harvests at +1 … +12 in H (sum of cells)
--   harvested_without_set    first harvested in H, never recorded SetFruit
--   harvested_after_timeout  first harvested in H after its +12 window
--   cells                    13 objects, +0 … +12; cell +N is the cohort set
--                            in week H − N (the ladder):
--     delay, set_year, set_week, cohort_sets (the denominator),
--     harvested (first harvested in H, i.e. at exactly +N),
--     percent (harvested ÷ cohort_sets × 100, or null (—) when the cohort has
--       no sets or H wasn't sampled), is_baseline_cohort,
--     cohort_harvested / cohort_aborted / cohort_pruned / cohort_timeout /
--       cohort_on_plant (sum to cohort_sets), cohort_closed
--   closing                  the cohort set in H − 12, whose window ends in H:
--     set_year, set_week, sets, harvested, aborted, pruned, timeout, on_plant,
--     closed, is_baseline_cohort, loss_percent ((aborted + pruned + timeout) ÷
--     sets × 100 once closed; null (—) while open or without sets)

drop function if exists public.set_harvest_cohorts(uuid, integer, timestamptz);

create function public.set_harvest_cohorts(
  p_crop_id uuid,
  p_year integer,
  p_as_of timestamptz default now()
)
returns table (
  iso_week                 integer,
  is_sampled               boolean,
  is_provisional           boolean,
  harvested_total          integer,
  harvested_in_window      integer,
  harvested_without_set    integer,
  harvested_after_timeout  integer,
  cells                    jsonb,
  closing                  jsonb
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
  node_weeks as (
    select * from public.crop_node_weeks(p_crop_id)
  ),
  stages as (
    select * from public.crop_node_stages(p_crop_id)
  ),
  stem_spans as (
    select measurement_stem_id, min(first_yw) as first_yw, max(last_yw) as last_yw
    from stages
    group by measurement_stem_id
  ),
  current_week as (
    select date_trunc('week', p_as_of at time zone 'America/Toronto')::date as week_start
  ),
  baseline as (
    select to_date((min(first_yw) / 100) || '-' || lpad((min(first_yw) % 100)::text, 2, '0'), 'IYYY-IW') as week_start
    from stages
  ),
  set_nodes as (
    select
      s.plant_node_id,
      s.set_week_start,
      s.harvested_week_start,
      case when s.harvested_week_start > s.set_week_start then (s.harvested_week_start - s.set_week_start) / 7 end as harvest_age,
      -- The +12 week (Monday) is over and was sampled.
      (s.set_week_start + 84 < (select week_start from current_week)
        and exists (
          select 1 from stem_spans sp
          where extract(isoyear from s.set_week_start + 84)::integer * 100 + extract(week from s.set_week_start + 84)::integer
                between sp.first_yw and sp.last_yw
        )) as closed,
      (select nw.status from node_weeks nw
        where nw.plant_node_id = s.plant_node_id and nw.week_start <= s.set_week_start + 84
        order by nw.week_start desc limit 1) as status_at_window_end
    from stages s
    where s.set_week_start is not null
  ),
  classified as (
    select *,
      case
        when harvest_age between 1 and 12 then 'harvested'
        when status_at_window_end = 'Aborted' then 'aborted'
        when status_at_window_end = 'Pruned' then 'pruned'
        when closed then 'timeout'
        else 'on_plant'
      end as outcome
    from set_nodes
  ),
  cohorts as (
    select
      set_week_start,
      count(*)::integer as sets,
      count(*) filter (where outcome = 'harvested')::integer as harvested,
      count(*) filter (where outcome = 'aborted')::integer as aborted,
      count(*) filter (where outcome = 'pruned')::integer as pruned,
      count(*) filter (where outcome = 'timeout')::integer as timeout,
      count(*) filter (where outcome = 'on_plant')::integer as on_plant,
      bool_and(closed) as closed
    from classified
    group by set_week_start
  ),
  pairs as (
    select set_week_start, harvest_age, count(*)::integer as n
    from classified
    where outcome = 'harvested'
    group by set_week_start, harvest_age
  )
  select
    w.iso_week,
    w.is_sampled,
    w.is_provisional,
    w.new_harvested,
    (select count(*) from classified c where c.outcome = 'harvested' and c.harvested_week_start = w.week_start)::integer,
    (select count(*) from stages s where s.set_week_start is null and s.harvested_week_start = w.week_start)::integer,
    (select count(*) from classified c where c.harvest_age > 12 and c.harvested_week_start = w.week_start)::integer,
    (
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
          'cohort_timeout', coalesce(c.timeout, 0),
          'cohort_on_plant', coalesce(c.on_plant, 0),
          'cohort_closed', coalesce(c.closed, false)
        )
        order by d
      )
      from generate_series(0, 12) as d
      left join cohorts c on c.set_week_start = w.week_start - 7 * d
      left join pairs p on p.set_week_start = w.week_start - 7 * d and p.harvest_age = d
    ),
    (
      select jsonb_build_object(
        'set_year', extract(isoyear from w.week_start - 84)::integer,
        'set_week', extract(week from w.week_start - 84)::integer,
        'sets', coalesce(c.sets, 0),
        'harvested', coalesce(c.harvested, 0),
        'aborted', coalesce(c.aborted, 0),
        'pruned', coalesce(c.pruned, 0),
        'timeout', coalesce(c.timeout, 0),
        'on_plant', coalesce(c.on_plant, 0),
        'closed', coalesce(c.closed, false),
        'is_baseline_cohort', coalesce(w.week_start - 84 = (select week_start from baseline), false),
        'loss_percent', case when c.closed and c.sets > 0 then (c.aborted + c.pruned + c.timeout) * 100.0 / c.sets end
      )
      from (select 1) as one
      left join cohorts c on c.set_week_start = w.week_start - 84
    )
  from weekly w
  order by w.iso_week
$$;

revoke execute on function public.set_harvest_cohorts(uuid, integer, timestamptz) from public, anon;
grant  execute on function public.set_harvest_cohorts(uuid, integer, timestamptz) to authenticated;
