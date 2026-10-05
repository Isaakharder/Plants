-- Projections › Weekly Plant Data: cohort window shortened from +12 to +10
--
-- Approved 2026-10-05: no pepper has legitimately been harvested 11 or more
-- weeks after SetFruit. The cohort clock is now:
--   +0          the SetFruit week
--   +1 … +10    valid harvest ages (a first Harvested record at +10 counts)
--   +11         a pepper not harvested by then is outside the window: it
--               resolves by its status at the end of +10 as Aborted, Pruned
--               or Timeout (unresolved at the cutoff)
-- A first Harvested record at +11 or later is not a cohort harvest; it stays
-- in the raw observations and in weekly_plant_data()'s Harvested/m², and is
-- reported per week as harvested_after_timeout.
--
-- set_harvest_cohorts() keeps its signature and output shape; only the window
-- changes: 11 cells (+0 … +10), a cohort closes when its +10 week is over and
-- was sampled, and its Loss appears on that row (closing = cohort H − 10).
-- weekly_plant_data(), crop_node_weeks() and crop_node_stages() are unchanged.
-- SECURITY INVOKER: every table is read with the caller's RLS.

create or replace function public.set_harvest_cohorts(
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
      -- The +10 week (Monday) is over and was sampled.
      (s.set_week_start + 70 < (select week_start from current_week)
        and exists (
          select 1 from stem_spans sp
          where extract(isoyear from s.set_week_start + 70)::integer * 100 + extract(week from s.set_week_start + 70)::integer
                between sp.first_yw and sp.last_yw
        )) as closed,
      (select nw.status from node_weeks nw
        where nw.plant_node_id = s.plant_node_id and nw.week_start <= s.set_week_start + 70
        order by nw.week_start desc limit 1) as status_at_window_end
    from stages s
    where s.set_week_start is not null
  ),
  classified as (
    select *,
      case
        when harvest_age between 1 and 10 then 'harvested'
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
    (select count(*) from classified c where c.harvest_age > 10 and c.harvested_week_start = w.week_start)::integer,
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
      from generate_series(0, 10) as d
      left join cohorts c on c.set_week_start = w.week_start - 7 * d
      left join pairs p on p.set_week_start = w.week_start - 7 * d and p.harvest_age = d
    ),
    (
      select jsonb_build_object(
        'set_year', extract(isoyear from w.week_start - 70)::integer,
        'set_week', extract(week from w.week_start - 70)::integer,
        'sets', coalesce(c.sets, 0),
        'harvested', coalesce(c.harvested, 0),
        'aborted', coalesce(c.aborted, 0),
        'pruned', coalesce(c.pruned, 0),
        'timeout', coalesce(c.timeout, 0),
        'on_plant', coalesce(c.on_plant, 0),
        'closed', coalesce(c.closed, false),
        'is_baseline_cohort', coalesce(w.week_start - 70 = (select week_start from baseline), false),
        'loss_percent', case when c.closed and c.sets > 0 then (c.aborted + c.pruned + c.timeout) * 100.0 / c.sets end
      )
      from (select 1) as one
      left join cohorts c on c.set_week_start = w.week_start - 70
    )
  from weekly w
  order by w.iso_week
$$;

revoke execute on function public.set_harvest_cohorts(uuid, integer, timestamptz) from public, anon;
grant  execute on function public.set_harvest_cohorts(uuid, integer, timestamptz) to authenticated;
