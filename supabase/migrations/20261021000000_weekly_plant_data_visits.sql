-- Projections › Weekly Plant Data: sampled stems from visit evidence
--
-- Approved 2026-10-15 after the sampled-stem audit. A stem now counts as
-- sampled in a week only when there is evidence it was visited that week
-- (crop_stem_weeks(): a status record, a growth reading, a node added, or an
-- explicit "stem checked"), instead of every week between its first and last
-- record. Consequences, audited on Mathieu 2026:
--   * W31 changes from 56 to 55 sampled stems (Row 27 / Stem 9 has no record
--     that week); every other historical week is unchanged.
--   * A week can no longer change after the fact: under the old rule, a stem
--     visited in W40 and W42 but not W41 was added to W41 once W42 was
--     recorded, diluting W41's per-m² values.
-- Before explicit stem checks existed, a stem visited with nothing changed
-- left no record, so legacy weeks can show a checked stem as unvisited; and a
-- record proves a visit, not that every node was inspected. sampling_weeks()
-- reports each week's coverage and whether it is a legacy week.
--
-- The same rule applies everywhere a week's sampled stems matter:
--   weekly_plant_data()    sampled stems, sampled m², per-m² values, baseline
--   weekly_fruit_loss()    fruit on the plant at the start of W counts only on
--                          stems visited in W
--   set_harvest_cohorts()  a cohort's +10 week counts as sampled when some
--                          stem was visited in it
-- Like the stage counts they divide, visits are read in full ('infinity'):
-- p_as_of still only decides which week is the current (provisional) one.
-- Signatures and output columns are unchanged. Observations are untouched.
-- SECURITY INVOKER throughout: every table is read with the caller's RLS.

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
  -- Stems with visit evidence in each week (crop_stem_weeks).
  visits as (
    select measurement_stem_id, yw from public.crop_stem_weeks((select id from crop), 'infinity') where visited
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
      (select count(*) from visits v where v.yw = w.yw)::integer as sampled_stems,
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
    coalesce(p.yw = (select min(yw) from visits), false),
    p.yw = (select yw from current_week)
  from per_week p
  cross join crop c
  order by p.iso_week
$$;


create or replace function public.weekly_fruit_loss(
  p_crop_id uuid,
  p_year integer,
  p_as_of timestamptz default now()
)
returns table (
  iso_week            integer,
  fruit_at_start      integer,
  fruit_lost          integer,
  fruit_aborted       integer,
  fruit_pruned        integer,
  flower_lost         integer,
  fruit_lost_per_m2   numeric,
  fruit_loss_percent  numeric,
  is_sampled          boolean,
  is_provisional      boolean
)
language sql
stable
security invoker
set search_path = ''
as $$
  with node_weeks as (
    select * from public.crop_node_weeks(p_crop_id)
  ),
  nodes as (
    select
      plant_node_id,
      measurement_stem_id,
      min(yw) filter (where status in ('SetFruit', 'MatureGreen', 'BreakerFruit')) as fruit_yw,
      min(yw) filter (where status = 'Harvested') as harvested_yw,
      max(yw) filter (where status not in ('Aborted', 'Pruned')) as last_live_yw
    from node_weeks
    group by plant_node_id, measurement_stem_id
  ),
  -- The confirmed loss: first loss record after the last non-loss record.
  losses as (
    select distinct on (n.plant_node_id) n.plant_node_id, nw.yw as loss_yw, nw.status as loss_status
    from nodes n
    join node_weeks nw on nw.plant_node_id = n.plant_node_id
    where nw.status in ('Aborted', 'Pruned')
      and (n.last_live_yw is null or nw.yw > n.last_live_yw)
    order by n.plant_node_id, nw.yw
  ),
  fates as (
    select n.*, l.loss_yw, l.loss_status
    from nodes n
    left join losses l using (plant_node_id)
  ),
  -- Stems with visit evidence in each week (crop_stem_weeks).
  visits as (
    select measurement_stem_id, yw from public.crop_stem_weeks(p_crop_id, 'infinity') where visited
  ),
  weeks as (
    select w.iso_week, p_year * 100 + w.iso_week as yw, w.sampled_m2, w.is_sampled, w.is_provisional
    from public.weekly_plant_data(p_crop_id, p_year, p_as_of) w
  ),
  per_week as (
    select
      w.*,
      (select count(*) from fates f join visits v on v.measurement_stem_id = f.measurement_stem_id and v.yw = w.yw
        where f.fruit_yw < w.yw
          and (f.harvested_yw is null or f.harvested_yw >= w.yw)
          and (f.loss_yw is null or f.loss_yw >= w.yw))::integer as at_start,
      (select count(*) from fates f join visits v on v.measurement_stem_id = f.measurement_stem_id and v.yw = w.yw
        where f.fruit_yw < w.yw
          and (f.harvested_yw is null or f.harvested_yw >= w.yw)
          and f.loss_yw = w.yw)::integer as lost,
      (select count(*) from fates f join visits v on v.measurement_stem_id = f.measurement_stem_id and v.yw = w.yw
        where f.fruit_yw < w.yw
          and (f.harvested_yw is null or f.harvested_yw >= w.yw)
          and f.loss_yw = w.yw and f.loss_status = 'Aborted')::integer as aborted,
      (select count(*) from fates f
        where f.loss_yw = w.yw and (f.fruit_yw is null or f.fruit_yw >= w.yw))::integer as flowers
    from weeks w
  )
  select
    p.iso_week,
    p.at_start,
    p.lost,
    p.aborted,
    p.lost - p.aborted,
    p.flowers,
    case when p.is_sampled then p.lost / p.sampled_m2 end,
    case when p.is_sampled and p.at_start > 0 then p.lost * 100.0 / p.at_start end,
    p.is_sampled,
    p.is_provisional
  from per_week p
  order by p.iso_week
$$;


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
  -- Weeks in which any stem has visit evidence (crop_stem_weeks).
  visited_weeks as (
    select distinct yw from public.crop_stem_weeks(p_crop_id, 'infinity') where visited
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
      -- The +10 week (Monday) is over and some stem was visited in it.
      (s.set_week_start + 70 < (select week_start from current_week)
        and exists (
          select 1 from visited_weeks v
          where v.yw = extract(isoyear from s.set_week_start + 70)::integer * 100 + extract(week from s.set_week_start + 70)::integer
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

