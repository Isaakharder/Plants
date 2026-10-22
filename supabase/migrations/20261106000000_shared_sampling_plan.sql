-- One sampling plan for every coverage figure: stem_sampling_plan()
--
-- Approved 2026-10-22. Until now Projections (sampling_weeks), the data-quality
-- checks (crop_quality_flags_all) and Plants › Metrics (weekly_variety_metrics)
-- expected a stem only from its first visited week, so a sampled stem that was
-- never visited was never expected (Cadalora: 84 sampled stems, 10 never
-- visited, W42 shown as 74 of 74). The collector ("x of y stems checked") and
-- the official forecast lock (forecast_lock_readiness) already count every
-- active stem of the variety's active rows. Now all of them share one rule.
--
-- stem_sampling_plan(crop, as_of): one row per sampling position (an active
-- measurement_stems record in an active row) known by as_of:
--   start_yw / start_week   the earlier of the greenhouse week (Toronto) the
--                           stem was created in and its first visited week
--                           (crop_stem_weeks). Never before it was created,
--                           unless records prove it was sampled earlier
--                           (imported history).
--   end_yw / end_week       the last week the position is expected. Always
--                           null for now: positions are never retired yet.
-- A stem counts as expected in week W when start <= W and (end is null or
-- end >= W); stems with no records still count. Visits, counts and every
-- per-m² value are unchanged: only the expected stems (the coverage
-- denominator) come from here.
--
-- A position is not a plant. A measurement_stems record is a sampling
-- position; a plant dying or being replaced at that position does not end it.
-- Planned (not built): positions get a retirement date and reason, and
-- end_yw becomes the week before retirement (kept through the retirement week
-- if it was visited then), so a retired position keeps its history instead of
-- disappearing; a record entered in error leaves the plan entirely; a plant
-- replacement is recorded against the position without ending it. Every
-- coverage figure then follows automatically, because they all read this
-- function.
--
-- Visits (crop_stem_weeks) and the plan cover the same stems: active stems of
-- active rows.
--
-- Consumers: sampling_weeks() (Projections, forecast scoring and the forecast
-- status line), crop_quality_flags_all() (incomplete_visit, missed_stem_visit,
-- and the >= 90% weeks unusual_weekly_count compares), weekly_variety_metrics().
-- forecast_lock_readiness() keeps its own count (active stems of active rows
-- created by the completion), which equals this plan at the completion time.
-- Signatures and output columns are unchanged. Observations are untouched.

-- ---------------------------------------------------------------------------
-- crop_stem_weeks(): visits only on stems of active rows (unchanged otherwise)
-- ---------------------------------------------------------------------------
-- A stem in a deactivated row was already out of the collector ("x of y") and
-- the forecast lock's count; its visits now leave the coverage figures too, so
-- visited stems are always among the expected ones. Rows can't be deactivated
-- in the app yet and none are, so no week changes.
create or replace function public.crop_stem_weeks(p_crop_id uuid, p_as_of timestamp with time zone default now())
returns table (measurement_stem_id uuid, yw integer, week_start date, has_observation boolean, has_growth boolean, has_new_node boolean, checked boolean, visited boolean)
language sql
stable
security invoker
set search_path = ''
as $$
  with evidence as (
    select n.measurement_stem_id as stem, o.year * 100 + o.week_number as yw, 'observation' as kind, null::boolean as checked
    from public.node_observations o
    join public.plant_nodes n on n.id = o.plant_node_id and n.is_active
    where o.crop_id = p_crop_id and o.recorded_at <= p_as_of
    union all
    select g.measurement_stem_id, g.year * 100 + g.week_number, 'growth', null
    from public.stem_growth_measurements g
    where g.crop_id = p_crop_id and g.observed_at <= p_as_of
    union all
    select n.measurement_stem_id,
           extract(isoyear from n.created_at at time zone 'America/Toronto')::integer * 100
             + extract(week from n.created_at at time zone 'America/Toronto')::integer,
           'node', null
    from public.plant_nodes n
    where n.crop_id = p_crop_id and n.is_active and n.created_at <= p_as_of
    union all
    -- The latest check (or retraction) per stem and week.
    select * from (
      select distinct on (v.measurement_stem_id, v.year, v.week_number)
             v.measurement_stem_id, v.year * 100 + v.week_number, 'visit', v.checked
      from public.stem_visits v
      where v.crop_id = p_crop_id and v.recorded_at <= p_as_of
      order by v.measurement_stem_id, v.year, v.week_number, v.observed_at desc, v.recorded_at desc, v.id desc
    ) latest_visit
  )
  select
    e.stem,
    e.yw,
    to_date((e.yw / 100) || '-' || lpad((e.yw % 100)::text, 2, '0'), 'IYYY-IW'),
    bool_or(e.kind = 'observation'),
    bool_or(e.kind = 'growth'),
    bool_or(e.kind = 'node'),
    bool_or(e.checked) filter (where e.kind = 'visit'),
    bool_or(e.kind <> 'visit' or e.checked)
  from evidence e
  join public.measurement_stems s on s.id = e.stem and s.is_active
  join public.measurement_rows r on r.id = s.measurement_row_id and r.is_active
  group by e.stem, e.yw
$$;
revoke execute on function public.crop_stem_weeks(uuid, timestamptz) from public, anon;
grant  execute on function public.crop_stem_weeks(uuid, timestamptz) to authenticated, service_role;

create or replace function public.stem_sampling_plan(p_crop_id uuid, p_as_of timestamptz default now())
returns table (
  measurement_stem_id  uuid,
  measurement_row_id   uuid,
  start_yw             integer,
  start_week           date,
  end_yw               integer,
  end_week             date
)
language sql
stable
security invoker
set search_path = ''
as $$
  with first_visit as (
    select w.measurement_stem_id, min(w.yw) as yw
    from public.crop_stem_weeks(p_crop_id, p_as_of) w
    where w.visited
    group by w.measurement_stem_id
  ),
  positions as (
    select s.id, s.measurement_row_id,
           least(
             extract(isoyear from s.created_at at time zone 'America/Toronto')::integer * 100
               + extract(week from s.created_at at time zone 'America/Toronto')::integer,
             f.yw
           ) as start_yw
    from public.measurement_stems s
    join public.measurement_rows r on r.id = s.measurement_row_id and r.is_active
    left join first_visit f on f.measurement_stem_id = s.id
    where s.crop_id = p_crop_id and s.is_active
      and (s.created_at <= p_as_of or f.yw is not null)
  )
  select p.id, p.measurement_row_id, p.start_yw,
         to_date((p.start_yw / 100) || '-' || lpad((p.start_yw % 100)::text, 2, '0'), 'IYYY-IW'),
         null::integer, null::date
  from positions p
$$;
revoke execute on function public.stem_sampling_plan(uuid, timestamptz) from public, anon;
grant  execute on function public.stem_sampling_plan(uuid, timestamptz) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- sampling_weeks(): expected_stems from the plan (unchanged otherwise)
-- ---------------------------------------------------------------------------
--   expected_stems   stems in the sampling plan that week (stem_sampling_plan)
create or replace function public.sampling_weeks(p_crop_id uuid, p_year integer, p_as_of timestamp with time zone default now())
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

-- ---------------------------------------------------------------------------
-- crop_quality_flags_all(): expected stems from the plan (unchanged otherwise)
-- ---------------------------------------------------------------------------
-- The judged weeks still run from the first visit to last week. A week is
-- incomplete_visit below 90% of the plan's stems (unvisited_stems lists them,
-- never-visited stems included); missed_stem_visit names each planned stem
-- without a record in a week of at least 90%.
create or replace function public.crop_quality_flags_all(p_crop_id uuid, p_as_of timestamp with time zone default now())
returns table (flag_key text, rule_id text, rule_version integer, category text, scope text, yw integer, week_start date, measurement_stem_id uuid, plant_node_id uuid, title text, explanation text, evidence jsonb, review_decision text, review_note text, reviewed_at timestamp with time zone, reviewed_by uuid)
language sql
stable
security invoker
set search_path = ''
as $$
  with recursive
  crop as (
    select c.id from public.crops c where c.id = p_crop_id
  ),
  current_week as (
    select date_trunc('week', p_as_of at time zone 'America/Toronto')::date as week_start
  ),
  -- One status per active node per week, as recorded by p_as_of.
  nw as (
    select distinct on (o.plant_node_id, o.year, o.week_number)
      o.plant_node_id as node,
      n.measurement_stem_id as stem,
      o.year * 100 + o.week_number as yw,
      to_date(o.year || '-' || lpad(o.week_number::text, 2, '0'), 'IYYY-IW') as ws,
      o.status
    from public.node_observations o
    join public.plant_nodes n on n.id = o.plant_node_id and n.is_active
    where o.crop_id = (select id from crop) and o.recorded_at <= p_as_of
    order by o.plant_node_id, o.year, o.week_number, o.observed_at desc, o.recorded_at desc, o.id desc
  ),
  stem_weeks as (
    select * from public.crop_stem_weeks((select id from crop), p_as_of) where visited
  ),
  -- The sampling plan: each stem's first and last expected week (stem_sampling_plan).
  plan as (
    select p.measurement_stem_id as stem, p.start_week as first_ws, p.end_week as last_ws
    from public.stem_sampling_plan((select id from crop), p_as_of) p
  ),
  -- Finished weeks from the first visit to the week before the current one.
  weeks as (
    select (select min(week_start) from stem_weeks) as ws
    union all
    select ws + 7 from weeks where ws + 7 < (select week_start from current_week)
  ),
  judged as (
    select w.ws,
           extract(isoyear from w.ws)::integer * 100 + extract(week from w.ws)::integer as yw,
           (select count(*) from plan f where f.first_ws <= w.ws and (f.last_ws is null or f.last_ws >= w.ws))::integer as expected,
           (select count(*) from stem_weeks s where s.week_start = w.ws)::integer as visited
    from weeks w
    where w.ws is not null and w.ws < (select week_start from current_week)
  ),
  node_stages as (
    select node, stem,
           min(ws) filter (where status = 'SetFruit') as set_ws,
           min(ws) filter (where status in ('MatureGreen')) as mg_ws,
           min(ws) filter (where status = 'BreakerFruit') as breaker_ws,
           min(ws) filter (where status = 'Harvested') as harvested_ws
    from nw
    group by node, stem
  ),
  -- Status at the start of a week: the latest record before it.
  -- Weekly breaker pick rate on visited stems.
  pick as (
    select j.ws, j.yw,
           count(*) filter (where b.node is not null)::integer as breakers_at_start,
           count(*) filter (where b.node is not null and ns.harvested_ws = j.ws)::integer as picked
    from judged j
    left join lateral (
      select ns2.node
      from node_stages ns2
      join stem_weeks sw on sw.measurement_stem_id = ns2.stem and sw.week_start = j.ws
      where ns2.breaker_ws < j.ws
        and (ns2.harvested_ws is null or ns2.harvested_ws >= j.ws)
        and coalesce((select x.status from nw x where x.node = ns2.node and x.ws < j.ws order by x.ws desc limit 1), '') not in ('Aborted', 'Pruned', 'Harvested')
    ) b on true
    left join node_stages ns on ns.node = b.node
    group by j.ws, j.yw
  ),
  pick_rated as (
    select p.*,
           case when p.breakers_at_start > 0 then p.picked::numeric / p.breakers_at_start end as rate,
           (select case when count(*) >= 3 then percentile_cont(0.5) within group (order by q.picked::numeric / q.breakers_at_start) end
              from pick q where q.ws < p.ws and q.breakers_at_start >= 10) as baseline
    from pick p
  ),
  weekly_counts as (
    select j.ws, j.yw, j.visited,
           (select count(*) from node_stages s where s.set_ws = j.ws)::numeric / nullif(j.visited, 0) as sets,
           (select count(*) from node_stages s where s.breaker_ws = j.ws)::numeric / nullif(j.visited, 0) as breakers,
           (select count(*) from node_stages s where s.harvested_ws = j.ws)::numeric / nullif(j.visited, 0) as harvests
    from judged j
    where j.visited::numeric >= 0.9 * j.expected and j.visited > 0
  ),
  unusual as (
    select wc.ws, wc.yw, m.measure, m.value, h.med, d.mad, h.n
    from weekly_counts wc
    cross join lateral (values ('sets', wc.sets), ('breakers', wc.breakers), ('harvests', wc.harvests)) as m(measure, value)
    cross join lateral (
      select array_agg(z.v) as vals
      from (select case m.measure when 'sets' then p.sets when 'breakers' then p.breakers else p.harvests end as v
            from weekly_counts p where p.ws < wc.ws order by p.ws desc limit 8) z
    ) a
    cross join lateral (select count(*) filter (where v > 0) as n, percentile_cont(0.5) within group (order by v) as med from unnest(a.vals) as v) h
    cross join lateral (select percentile_cont(0.5) within group (order by abs(v - h.med)) as mad from unnest(a.vals) as v) d
    where h.n >= 5 and abs(m.value - h.med) > greatest(4 * d.mad, 0.5 * h.med, 0.5)
  ),
  stem_last_visit as (
    select measurement_stem_id as stem, max(week_start) as ws
    from stem_weeks
    where week_start < (select week_start from current_week)
    group by 1
  ),
  latest as (
    select distinct on (node) node, stem, status, ws
    from nw
    order by node, ws desc
  ),
  latest_since as (
    -- Week the node's current status began (first week of its final run).
    select l.node, l.stem, l.status,
           (select min(x.ws) from nw x where x.node = l.node and x.status = l.status
              and not exists (select 1 from nw y where y.node = l.node and y.ws > x.ws and y.status <> l.status)) as since_ws
    from latest l
  ),
  stage_rank as (
    select * from (values ('Flower', 1), ('SetFruit', 2), ('MatureGreen', 3), ('BreakerFruit', 4), ('Harvested', 5)) as r(status, rank)
  ),
  regressions as (
    select distinct on (a.node) a.node, a.stem, b.ws, a.status as before_status, a.ws as before_ws, b.status as after_status
    from nw a
    join nw b on b.node = a.node and b.ws > a.ws
    join stage_rank ra on ra.status = a.status
    join stage_rank rb on rb.status = b.status
    where rb.rank < ra.rank
    order by a.node, b.ws, a.ws desc
  ),
  flags as (
    -- incomplete_visit
    select 'incomplete_visit:' || j.yw as flag_key, 'incomplete_visit' as rule_id, 1 as rule_version, 'coverage' as category,
           'week' as scope, j.yw, j.ws, null::uuid as stem, null::uuid as node,
           format('Incomplete visit: %s of %s stems', j.visited, j.expected) as title,
           format('Only %s of the %s sampled stems have any record in W%s. The other %s were not visited, or were checked with nothing changed; their fruit is treated as not observed that week, never as zero harvests.',
                  j.visited, j.expected, j.yw % 100, j.expected - j.visited) as explanation,
           jsonb_build_object('expected_stems', j.expected, 'visited_stems', j.visited,
             'unvisited_stems', (select coalesce(jsonb_agg(jsonb_build_object('stem_id', f.stem, 'stem', ms.stem_name, 'row', r.row_name) order by r.sort_order, r.row_name, ms.sort_order, ms.stem_name), '[]'::jsonb)
                                 from plan f
                                 join public.measurement_stems ms on ms.id = f.stem
                                 join public.measurement_rows r on r.id = ms.measurement_row_id
                                 where f.first_ws <= j.ws and (f.last_ws is null or f.last_ws >= j.ws) and not exists (select 1 from stem_weeks s where s.measurement_stem_id = f.stem and s.week_start = j.ws))) as evidence
    from judged j
    where j.visited > 0 and j.visited::numeric < 0.9 * j.expected

    union all
    -- missed_stem_visit
    select 'missed_stem_visit:' || j.yw || ':' || f.stem, 'missed_stem_visit', 1, 'coverage',
           'stem_week', j.yw, j.ws, f.stem, null,
           format('No record on %s / %s', r.row_name, ms.stem_name),
           format('%s / %s has no record in W%s while %s of %s stems do. It was skipped, or checked with nothing changed; its fruit is treated as not observed that week.',
                  r.row_name, ms.stem_name, j.yw % 100, j.visited, j.expected),
           jsonb_build_object('row', r.row_name, 'stem', ms.stem_name, 'visited_stems', j.visited, 'expected_stems', j.expected,
             'live_fruit', (select count(*) from node_stages s where s.stem = f.stem and coalesce(s.set_ws, s.mg_ws, s.breaker_ws) < j.ws
                              and (s.harvested_ws is null or s.harvested_ws >= j.ws)
                              and coalesce((select x.status from nw x where x.node = s.node and x.ws < j.ws order by x.ws desc limit 1), '') not in ('Aborted', 'Pruned', 'Harvested')))
    from judged j
    join plan f on f.first_ws <= j.ws and (f.last_ws is null or f.last_ws >= j.ws)
    join public.measurement_stems ms on ms.id = f.stem
    join public.measurement_rows r on r.id = ms.measurement_row_id
    where j.visited::numeric >= 0.9 * j.expected
      and not exists (select 1 from stem_weeks s where s.measurement_stem_id = f.stem and s.week_start = j.ws)

    union all
    -- harvest_not_recorded
    select 'harvest_not_recorded:' || p.yw, 'harvest_not_recorded', 1, 'possible_recording_error',
           'week', p.yw, p.ws, null, null,
           format('Harvests possibly not recorded in W%s', p.yw % 100),
           format('%s fruit were at Breaker on the visited stems at the start of W%s, but %s (%s%%) were recorded Harvested. Usually %s%% are. Harvests may not have been logged this week; if the crop really was not picked, mark this legitimate.',
                  p.breakers_at_start, p.yw % 100, p.picked, round(100 * p.rate), round(100 * coalesce(p.baseline, 0.6))),
           jsonb_build_object('breakers_at_start', p.breakers_at_start, 'recorded_harvested', p.picked, 'pick_rate', round(p.rate, 3),
             'usual_pick_rate', round(coalesce(p.baseline, 0.6)::numeric, 3), 'threshold', round(0.5 * coalesce(p.baseline, 0.6)::numeric, 3),
             'baseline_source', case when p.baseline is null then 'default' else 'crop_history' end,
             'next_week_pick_rate', (select round(n.picked::numeric / nullif(n.breakers_at_start, 0), 3) from pick n where n.ws = p.ws + 7))
    from pick_rated p
    where p.breakers_at_start >= 10 and p.rate < 0.5 * coalesce(p.baseline, 0.6)

    union all
    -- stage_regression
    select 'stage_regression:' || g.node, 'stage_regression', 1, 'possible_recording_error',
           'node', extract(isoyear from g.ws)::integer * 100 + extract(week from g.ws)::integer, g.ws, g.stem, g.node,
           format('Stage went backwards: %s → %s', g.before_status, g.after_status),
           format('This node was recorded %s in W%s and %s later, in W%s. A fruit cannot return to an earlier stage, so one of these records is probably a mis-tap.',
                  g.before_status, extract(week from g.before_ws)::integer, g.after_status, extract(week from g.ws)::integer),
           jsonb_build_object('earlier_status', g.before_status, 'earlier_week', to_char(g.before_ws, 'IYYY-"W"IW'),
                              'later_status', g.after_status, 'later_week', to_char(g.ws, 'IYYY-"W"IW'))
    from regressions g

    union all
    -- harvest_without_ripening
    select 'harvest_without_ripening:' || s.node, 'harvest_without_ripening', 1, 'possible_recording_error',
           'node', extract(isoyear from s.harvested_ws)::integer * 100 + extract(week from s.harvested_ws)::integer, s.harvested_ws, s.stem, s.node,
           'Harvested without MatureGreen or Breaker',
           format('Recorded Harvested in W%s with no earlier MatureGreen or Breaker record%s. The ripening stages were probably not logged, so its ripening time is unknown.',
                  extract(week from s.harvested_ws)::integer,
                  case when s.set_ws is not null then format(' (set in W%s)', extract(week from s.set_ws)::integer) else '' end),
           jsonb_build_object('set_week', to_char(s.set_ws, 'IYYY-"W"IW'), 'harvested_week', to_char(s.harvested_ws, 'IYYY-"W"IW'),
             'last_status_before', (select x.status from nw x where x.node = s.node and x.ws < s.harvested_ws order by x.ws desc limit 1))
    from node_stages s
    where s.harvested_ws is not null
      and coalesce(s.mg_ws, s.breaker_ws) is null
      and s.harvested_ws < (select week_start from current_week)

    union all
    -- stale_status
    select 'stale_status:' || l.node || ':' || l.status, 'stale_status', 1, 'possible_recording_error',
           'node', extract(isoyear from l.since_ws)::integer * 100 + extract(week from l.since_ws)::integer, l.since_ws, l.stem, l.node,
           format('Still %s after %s weeks', l.status, (v.ws - l.since_ws) / 7),
           format('Recorded %s since W%s and unchanged for %s weeks, although its stem was visited as late as W%s. Fruit rarely stays at this stage this long; the status may not have been updated.',
                  l.status, extract(week from l.since_ws)::integer, (v.ws - l.since_ws) / 7, extract(week from v.ws)::integer),
           jsonb_build_object('status', l.status, 'since_week', to_char(l.since_ws, 'IYYY-"W"IW'),
                              'stem_last_visit', to_char(v.ws, 'IYYY-"W"IW'), 'weeks', (v.ws - l.since_ws) / 7,
                              'limit_weeks', case l.status when 'SetFruit' then 10 when 'MatureGreen' then 6 else 4 end)
    from latest_since l
    join stem_last_visit v on v.stem = l.stem
    where l.status in ('SetFruit', 'MatureGreen', 'BreakerFruit')
      and (v.ws - l.since_ws) / 7 >= case l.status when 'SetFruit' then 10 when 'MatureGreen' then 6 else 4 end

    union all
    -- long_development
    select 'long_development:' || s.node, 'long_development', 1, 'possible_recording_error',
           'node', extract(isoyear from s.harvested_ws)::integer * 100 + extract(week from s.harvested_ws)::integer, s.harvested_ws, s.stem, s.node,
           format('Harvested %s weeks after set', (s.harvested_ws - coalesce(s.set_ws, s.mg_ws, s.breaker_ws)) / 7),
           format('First recorded as fruit in W%s and Harvested in W%s, %s weeks later. That is unusually long: it may be a slow fruit, or records of two different peppers on one node (a node mix-up) or a missed update. Confirm as a recording error to keep it out of the timing the model learns.',
                  extract(week from coalesce(s.set_ws, s.mg_ws, s.breaker_ws))::integer, extract(week from s.harvested_ws)::integer,
                  (s.harvested_ws - coalesce(s.set_ws, s.mg_ws, s.breaker_ws)) / 7),
           jsonb_build_object('first_fruit_week', to_char(coalesce(s.set_ws, s.mg_ws, s.breaker_ws), 'IYYY-"W"IW'),
                              'harvested_week', to_char(s.harvested_ws, 'IYYY-"W"IW'),
                              'weeks', (s.harvested_ws - coalesce(s.set_ws, s.mg_ws, s.breaker_ws)) / 7, 'limit_weeks', 10)
    from node_stages s
    where s.harvested_ws is not null
      and coalesce(s.set_ws, s.mg_ws, s.breaker_ws) is not null
      and (s.harvested_ws - coalesce(s.set_ws, s.mg_ws, s.breaker_ws)) / 7 > 10

    union all
    -- unusual_weekly_count
    select 'unusual_weekly_count:' || u.yw || ':' || u.measure, 'unusual_weekly_count', 1, 'unusual_crop_event',
           'week', u.yw, u.ws, null, null,
           format('Unusual number of new %s in W%s', u.measure, u.yw % 100),
           format('%s new %s per visited stem in W%s, against a usual %s (previous %s weeks). This may be a real crop event (a flush, abortion, a picking change) or a logging problem.',
                  round(u.value::numeric, 2), u.measure, u.yw % 100, round(u.med::numeric, 2), u.n),
           jsonb_build_object('measure', u.measure, 'per_visited_stem', round(u.value::numeric, 3), 'usual', round(u.med::numeric, 3),
                              'mad', round(u.mad::numeric, 3), 'weeks_compared', u.n)
    from unusual u
  ),
  reviews as (
    select distinct on (r.flag_key) r.flag_key, r.decision, r.note, r.reviewed_at, r.reviewed_by
    from public.data_quality_reviews r
    where r.crop_id = (select id from crop) and r.reviewed_at <= p_as_of
    order by r.flag_key, r.reviewed_at desc, r.id desc
  )
  select f.flag_key, f.rule_id, f.rule_version, f.category, f.scope, f.yw, f.ws, f.stem, f.node,
         f.title, f.explanation, f.evidence,
         nullif(r.decision, 'unreviewed'), r.note, r.reviewed_at, r.reviewed_by
  from flags f
  left join reviews r on r.flag_key = f.flag_key
  order by f.ws, f.rule_id, f.flag_key
$$;

-- ---------------------------------------------------------------------------
-- weekly_variety_metrics(): expected_stems from the plan (unchanged otherwise)
-- ---------------------------------------------------------------------------
--   expected_stems   stems in the variety's sampling plan that week
--                    (stem_sampling_plan). stems < 90% of it = partial sampling.
create or replace function public.weekly_variety_metrics(p_organization_id uuid)
returns table (crop_id uuid, yw integer, stems integer, expected_stems integer, rows_ integer, set_fruit integer, fruit_load integer, breakers integer)
language sql
stable
security invoker
set search_path = ''
as $$
  with crops as (
    select c.id from public.crops c where c.organization_id = p_organization_id
  ),
  visits as materialized (
    select c.id as crop_id, w.measurement_stem_id as stem_id, w.yw
      from crops c cross join lateral public.crop_stem_weeks(c.id, 'infinity') w
     where w.visited
  ),
  -- Each node's status from the week it was recorded until its next recorded week.
  spans as materialized (
    select nw.plant_node_id, nw.measurement_stem_id as stem_id, nw.yw, nw.status,
           lead(nw.yw) over (partition by nw.plant_node_id order by nw.yw) as next_yw
      from crops c cross join lateral public.crop_node_weeks(c.id) nw
  ),
  -- Each node's identity on its stem: duplicates share a key.
  node_keys as (
    select n.id,
           case when n.is_side_shoot and n.node_label is not null then 'shoot:' || n.parent_node_id || ':' || n.node_label
                when n.is_side_shoot then 'node:' || n.id
                else 'main:' || n.node_number end as node_key
      from public.plant_nodes n
      join crops c on c.id = n.crop_id
     where n.is_active
  ),
  -- On each visited stem and week: each node's latest status in or before that week.
  states as (
    select v.crop_id, v.stem_id, v.yw, sp.plant_node_id, sp.status, sp.yw as status_yw
      from visits v
      join spans sp on sp.stem_id = v.stem_id and sp.yw <= v.yw and (sp.next_yw is null or sp.next_yw > v.yw)
  ),
  -- One record per duplicate group: the one with the newest observation.
  counted as (
    select distinct on (st.stem_id, st.yw, k.node_key) st.*
      from states st
      join node_keys k on k.id = st.plant_node_id
     order by st.stem_id, st.yw, k.node_key, st.status_yw desc, st.plant_node_id
  ),
  -- The sampling plan: each stem's first and last expected week (stem_sampling_plan).
  plan as materialized (
    select c.id as crop_id, p.start_yw, p.end_yw
      from crops c cross join lateral public.stem_sampling_plan(c.id, 'infinity') p
  ),
  stem_counts as (
    select v.crop_id, v.yw, v.stem_id, s.measurement_row_id,
           count(c.plant_node_id) filter (where c.status = 'SetFruit') as set_fruit,
           count(c.plant_node_id) filter (where c.status in ('SetFruit', 'MatureGreen', 'BreakerFruit')) as fruit_load,
           count(c.plant_node_id) filter (where c.status = 'BreakerFruit') as breakers
      from visits v
      join public.measurement_stems s on s.id = v.stem_id
      left join counted c on c.stem_id = v.stem_id and c.yw = v.yw
     group by v.crop_id, v.yw, v.stem_id, s.measurement_row_id
  )
  select sc.crop_id, sc.yw,
         count(*)::integer,
         (select count(*) from plan f where f.crop_id = sc.crop_id and f.start_yw <= sc.yw and (f.end_yw is null or f.end_yw >= sc.yw))::integer,
         count(distinct measurement_row_id)::integer,
         sum(set_fruit)::integer,
         sum(fruit_load)::integer,
         sum(breakers)::integer
    from stem_counts sc
   group by sc.crop_id, sc.yw
   order by sc.crop_id, sc.yw
$$;

revoke execute on function public.sampling_weeks(uuid, integer, timestamptz) from public, anon;
grant  execute on function public.sampling_weeks(uuid, integer, timestamptz) to authenticated, service_role;
revoke execute on function public.crop_quality_flags_all(uuid, timestamptz) from public, anon;
grant  execute on function public.crop_quality_flags_all(uuid, timestamptz) to authenticated, service_role;
revoke execute on function public.weekly_variety_metrics(uuid) from public, anon;
grant  execute on function public.weekly_variety_metrics(uuid) to authenticated;
