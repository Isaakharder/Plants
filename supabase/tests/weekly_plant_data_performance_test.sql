-- 20261110 Weekly Plant Data performance: set_harvest_cohorts(), weekly_fruit_loss()
-- and sampling_weeks() return exactly what their previous definitions returned,
-- for every crop, every year with observations and a range of as-of times.
-- The previous definitions (20261021 and 20261106) are recreated below as
-- temporary reference functions.
--
-- Runs inside a transaction that is always rolled back.
--   npx supabase db query --linked -f supabase/tests/weekly_plant_data_performance_test.sql
-- Prints {"result": "weekly_plant_data_performance tests passed"} on success.

begin;

create function pg_temp.ref_set_harvest_cohorts(
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

create function pg_temp.ref_weekly_fruit_loss(
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

create function pg_temp.ref_sampling_weeks(p_crop_id uuid, p_year integer, p_as_of timestamp with time zone default now())
returns table (iso_week integer, expected_stems integer, visited_stems integer, checked_stems integer, unvisited_stems integer, visited_m2 numeric, coverage numeric, tracking text, completion text, completed_at timestamp with time zone, state text, is_provisional boolean)
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
  stem_weeks as (
    select * from public.crop_stem_weeks((select id from crop), p_as_of)
  ),
  plan as (
    select * from public.stem_sampling_plan((select id from crop), p_as_of)
  ),
  tracking_start as (
    select least(
      (select min(v.year * 100 + v.week_number) from public.stem_visits v where v.crop_id = (select id from crop) and v.recorded_at <= p_as_of),
      (select min(e.year * 100 + e.week_number) from public.sampling_week_events e where e.crop_id = (select id from crop) and e.recorded_at <= p_as_of)
    ) as yw
  ),
  events as (
    select distinct on (e.year, e.week_number) e.year * 100 + e.week_number as yw, e.event, e.recorded_at
    from public.sampling_week_events e
    where e.crop_id = (select id from crop) and e.recorded_at <= p_as_of
    order by e.year, e.week_number, e.recorded_at desc, e.id desc
  ),
  current_week as (
    select extract(isoyear from p_as_of at time zone 'America/Toronto')::integer * 100
         + extract(week from p_as_of at time zone 'America/Toronto')::integer as yw
  ),
  per_week as (
    select
      w as iso_week,
      p_year * 100 + w as yw,
      (select count(*) from plan f where f.start_yw <= p_year * 100 + w and (f.end_yw is null or f.end_yw >= p_year * 100 + w))::integer as expected,
      (select count(*) from stem_weeks s where s.yw = p_year * 100 + w and s.visited)::integer as visited,
      (select count(*) from stem_weeks s where s.yw = p_year * 100 + w and s.checked)::integer as checked
    from generate_series(1, public.iso_weeks_in_year(p_year)) as w
  )
  select
    p.iso_week,
    p.expected,
    p.visited,
    p.checked,
    p.expected - p.visited,
    case when p.visited > 0 then p.visited / c.stems_per_m2 end,
    case when p.expected > 0 then round(p.visited::numeric / p.expected, 4) end,
    case when p.yw >= (select yw from tracking_start) then 'explicit' else 'legacy' end,
    e.event,
    case when e.event = 'completed' then e.recorded_at end,
    case
      when e.event = 'completed' then 'complete'
      when p.yw < (select yw from current_week) and not coalesce(p.yw >= (select yw from tracking_start), false) then 'legacy'
      when p.visited > 0 or e.event = 'reopened' then 'in_progress'
      else 'not_started'
    end,
    p.yw = (select yw from current_week)
  from per_week p
  cross join crop c
  left join events e on e.yw = p.yw
  order by p.iso_week
$$;

do $$
declare
  r record;
  n integer;
begin
  for r in
    select c.id as crop_id, c.name, y.year, a.as_of
    from public.crops c
    join lateral (select distinct o.year from public.node_observations o where o.crop_id = c.id) y on true
    cross join (values (now()), (now() - interval '7 days'), (now() - interval '91 days'), (timestamptz '2026-06-04 16:00Z')) a(as_of)
  loop
    select count(*) into n from (
      (select to_jsonb(x) from public.set_harvest_cohorts(r.crop_id, r.year, r.as_of) x
       except all select to_jsonb(x) from pg_temp.ref_set_harvest_cohorts(r.crop_id, r.year, r.as_of) x)
      union all
      (select to_jsonb(x) from pg_temp.ref_set_harvest_cohorts(r.crop_id, r.year, r.as_of) x
       except all select to_jsonb(x) from public.set_harvest_cohorts(r.crop_id, r.year, r.as_of) x)
    ) d;
    if n > 0 then raise exception 'FAIL: set_harvest_cohorts differs for crop % (%), year %, as of %', r.name, r.crop_id, r.year, r.as_of; end if;

    select count(*) into n from (
      (select to_jsonb(x) from public.weekly_fruit_loss(r.crop_id, r.year, r.as_of) x
       except all select to_jsonb(x) from pg_temp.ref_weekly_fruit_loss(r.crop_id, r.year, r.as_of) x)
      union all
      (select to_jsonb(x) from pg_temp.ref_weekly_fruit_loss(r.crop_id, r.year, r.as_of) x
       except all select to_jsonb(x) from public.weekly_fruit_loss(r.crop_id, r.year, r.as_of) x)
    ) d;
    if n > 0 then raise exception 'FAIL: weekly_fruit_loss differs for crop % (%), year %, as of %', r.name, r.crop_id, r.year, r.as_of; end if;

    select count(*) into n from (
      (select to_jsonb(x) from public.sampling_weeks(r.crop_id, r.year, r.as_of) x
       except all select to_jsonb(x) from pg_temp.ref_sampling_weeks(r.crop_id, r.year, r.as_of) x)
      union all
      (select to_jsonb(x) from pg_temp.ref_sampling_weeks(r.crop_id, r.year, r.as_of) x
       except all select to_jsonb(x) from public.sampling_weeks(r.crop_id, r.year, r.as_of) x)
    ) d;
    if n > 0 then raise exception 'FAIL: sampling_weeks differs for crop % (%), year %, as of %', r.name, r.crop_id, r.year, r.as_of; end if;
  end loop;
end $$;

-- Signatures, security and grants are unchanged.
do $$
begin
  if exists (
    select 1 from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and p.proname in ('set_harvest_cohorts', 'weekly_fruit_loss', 'sampling_weeks')
      and (p.prosecdef or p.provolatile <> 's'
           or not has_function_privilege('authenticated', p.oid, 'execute')
           or has_function_privilege('anon', p.oid, 'execute'))
  ) then raise exception 'FAIL: security, volatility or grants changed'; end if;
end $$;

select 'weekly_plant_data_performance tests passed' as result;
rollback;
