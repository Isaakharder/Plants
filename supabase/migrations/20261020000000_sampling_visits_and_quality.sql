-- Plants: sampling visits, sampling completion and data-quality flags
--
-- Foundations for the Harvest Forecast (approved 2026-10-15). Additive only:
-- no existing table, function or observation is changed.
--
--   stem_visits            append-only: a worker confirms a stem was checked
--                          in a week (or retracts that). The only proof that a
--                          stem was visited even when none of its nodes changed.
--   sampling_week_events   append-only: a crop's weekly sampling marked
--                          complete, or reopened.
--   data_quality_reviews   append-only: a person's decision on a flag
--                          (recording error / legitimate crop event / reopened).
--
--   crop_stem_weeks(crop, as_of)          visit evidence per stem and week
--   sampling_weeks(crop, year, as_of)     per-week coverage and completion
--   crop_quality_flags(crop, as_of)       suspicious data, computed, with the
--                                         evidence behind each flag and its
--                                         latest review
--
-- Visit evidence (a stem was visited in week W if any of these is true):
--   * it was confirmed checked (latest stem_visits row that week),
--   * one of its nodes got a status record that week,
--   * it got a vegetative growth reading that week,
--   * a node was added to it that week.
-- Records only prove presence. Before stem_visits existed the collector only
-- recorded changes, so a stem with no record in a week is "no evidence":
-- skipped, or checked with nothing changed. History is never filled in.
--
-- Flags are computed from the data on every call (nothing is stored but the
-- reviews), so a flag always shows the evidence it was raised on. p_as_of
-- limits every input to what had been recorded by then, so a backtest sees
-- only flags (and reviews) that existed at its cutoff. A flag's key identifies
-- what it is about (rule + week / stem / node), not the rule version, so a
-- review survives a rule refinement.
--
-- Flags never change or hide observations. An unreviewed flag is a warning:
-- the data is still used as recorded. Only a flag confirmed as a recording
-- error is excluded from model training. A missing visit is never a zero.
--
-- SECURITY INVOKER: every table is read with the caller's RLS.

-- ---------------------------------------------------------------------------
-- stem_visits
-- ---------------------------------------------------------------------------

create table public.stem_visits (
  id                   uuid primary key default gen_random_uuid(),
  organization_id      uuid not null,
  crop_id              uuid not null,
  measurement_stem_id  uuid not null,
  -- Greenhouse ISO week (America/Toronto) at the moment of the check.
  year                 integer not null check (year between 2000 and 2100),
  week_number          integer not null,
  -- false retracts an earlier check in the same week (a mis-tap).
  checked              boolean not null default true,
  observed_at          timestamptz not null,
  recorded_at          timestamptz not null default now(),
  created_by           uuid references auth.users (id) on delete set null default auth.uid(),
  constraint stem_visits_stem_fkey
    foreign key (organization_id, crop_id, measurement_stem_id)
    references public.measurement_stems (organization_id, crop_id, id) on delete cascade,
  constraint stem_visits_iso_week_check
    check (week_number between 1 and public.iso_weeks_in_year(year))
);

create index stem_visits_crop_week_idx on public.stem_visits (crop_id, year, week_number);
create index stem_visits_stem_idx on public.stem_visits (measurement_stem_id, year, week_number, observed_at desc);

comment on table public.stem_visits is
  'Append-only: a worker confirmed a sampled stem was checked in a greenhouse week (checked = false retracts it). The latest row per stem and week wins.';

-- ---------------------------------------------------------------------------
-- sampling_week_events
-- ---------------------------------------------------------------------------

create table public.sampling_week_events (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null,
  crop_id          uuid not null,
  year             integer not null check (year between 2000 and 2100),
  week_number      integer not null,
  event            text not null check (event in ('completed', 'reopened')),
  note             text check (char_length(note) <= 500),
  observed_at      timestamptz not null default now(),
  recorded_at      timestamptz not null default now(),
  created_by       uuid references auth.users (id) on delete set null default auth.uid(),
  constraint sampling_week_events_crop_fkey
    foreign key (organization_id, crop_id)
    references public.crops (organization_id, id) on delete cascade,
  constraint sampling_week_events_iso_week_check
    check (week_number between 1 and public.iso_weeks_in_year(year))
);

create index sampling_week_events_crop_week_idx on public.sampling_week_events (crop_id, year, week_number, recorded_at desc);

comment on table public.sampling_week_events is
  'Append-only: a crop''s weekly sampling marked complete or reopened. The latest event per crop and week is its state.';

-- ---------------------------------------------------------------------------
-- data_quality_reviews
-- ---------------------------------------------------------------------------

create table public.data_quality_reviews (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null,
  crop_id          uuid not null,
  flag_key         text not null check (char_length(flag_key) between 1 and 200),
  rule_id          text not null check (char_length(rule_id) between 1 and 60),
  decision         text not null check (decision in ('recording_error', 'legitimate', 'unreviewed')),
  note             text check (char_length(note) <= 1000),
  -- The flag as the reviewer saw it (rule version, explanation, evidence).
  flag_snapshot    jsonb not null default '{}'::jsonb,
  reviewed_at      timestamptz not null default now(),
  reviewed_by      uuid references auth.users (id) on delete set null default auth.uid(),
  constraint data_quality_reviews_crop_fkey
    foreign key (organization_id, crop_id)
    references public.crops (organization_id, id) on delete cascade
);

create index data_quality_reviews_flag_idx on public.data_quality_reviews (crop_id, flag_key, reviewed_at desc);

comment on table public.data_quality_reviews is
  'Append-only review log for computed data-quality flags. The latest decision per flag wins; ''unreviewed'' reopens a flag.';

-- ---------------------------------------------------------------------------
-- Row level security and grants: read and append only
-- ---------------------------------------------------------------------------

alter table public.stem_visits          enable row level security;
alter table public.sampling_week_events enable row level security;
alter table public.data_quality_reviews enable row level security;

create policy "Members can read stem visits"
  on public.stem_visits for select to authenticated
  using (public.is_org_member(organization_id));
create policy "Members can record stem visits"
  on public.stem_visits for insert to authenticated
  with check (public.is_org_member(organization_id));

create policy "Members can read sampling weeks"
  on public.sampling_week_events for select to authenticated
  using (public.is_org_member(organization_id));
create policy "Members can complete or reopen sampling weeks"
  on public.sampling_week_events for insert to authenticated
  with check (public.is_org_member(organization_id));

create policy "Members can read data-quality reviews"
  on public.data_quality_reviews for select to authenticated
  using (public.is_org_member(organization_id));
create policy "Members can review data-quality flags"
  on public.data_quality_reviews for insert to authenticated
  with check (public.is_org_member(organization_id) and reviewed_by = (select auth.uid()));

revoke all on public.stem_visits, public.sampling_week_events, public.data_quality_reviews from anon, authenticated;
grant select, insert on public.stem_visits          to authenticated;
grant select, insert on public.sampling_week_events to authenticated;
grant select, insert on public.data_quality_reviews to authenticated;

-- ---------------------------------------------------------------------------
-- crop_stem_weeks(): visit evidence per stem and week
-- ---------------------------------------------------------------------------
--
-- One row per active stem of the crop and week with any visit evidence
-- recorded by p_as_of. checked is the latest stem_visits row that week (null
-- when there is none). visited is true when there is any evidence at all.

create or replace function public.crop_stem_weeks(p_crop_id uuid, p_as_of timestamptz default now())
returns table (
  measurement_stem_id  uuid,
  yw                   integer,
  week_start           date,
  has_observation      boolean,
  has_growth           boolean,
  has_new_node         boolean,
  checked              boolean,
  visited              boolean
)
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
  group by e.stem, e.yw
$$;

revoke execute on function public.crop_stem_weeks(uuid, timestamptz) from public, anon;
grant  execute on function public.crop_stem_weeks(uuid, timestamptz) to authenticated;

-- ---------------------------------------------------------------------------
-- sampling_weeks(): per-week coverage and completion
-- ---------------------------------------------------------------------------
--
-- One row per ISO week of p_year:
--   expected_stems   active stems already in the sample (first visit evidence
--                    in or before this week)
--   visited_stems    of those, stems with visit evidence this week
--   checked_stems    of those, stems explicitly confirmed checked
--   unvisited_stems  expected − visited: no evidence (never a zero harvest)
--   visited_m2       visited stems ÷ (picking stems ÷ area): the sampled area
--                    a weekly count from these stems represents
--   coverage         visited ÷ expected (null when nothing is expected)
--   tracking         'explicit' once the crop has any stem_visits or
--                    sampling_week_events record in or before this week,
--                    else 'legacy' (only status changes were recorded)
--   completion       latest sampling_week_events event by p_as_of
--                    ('completed' / 'reopened') or null
--   completed_at     when the week was last marked complete (null otherwise)
--   state            'complete' | 'in_progress' | 'not_started' | 'legacy'
--                    (legacy: a past week from before explicit tracking)
--   is_provisional   the current greenhouse week at p_as_of

create or replace function public.sampling_weeks(p_crop_id uuid, p_year integer, p_as_of timestamptz default now())
returns table (
  iso_week         integer,
  expected_stems   integer,
  visited_stems    integer,
  checked_stems    integer,
  unvisited_stems  integer,
  visited_m2       numeric,
  coverage         numeric,
  tracking         text,
  completion       text,
  completed_at     timestamptz,
  state            text,
  is_provisional   boolean
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
  stem_weeks as (
    select * from public.crop_stem_weeks((select id from crop), p_as_of)
  ),
  stem_first as (
    select measurement_stem_id, min(yw) as first_yw
    from stem_weeks
    where visited
    group by measurement_stem_id
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
      (select count(*) from stem_first f where f.first_yw <= p_year * 100 + w)::integer as expected,
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

revoke execute on function public.sampling_weeks(uuid, integer, timestamptz) from public, anon;
grant  execute on function public.sampling_weeks(uuid, integer, timestamptz) to authenticated;

-- ---------------------------------------------------------------------------
-- crop_quality_flags(): suspicious data, with evidence and latest review
-- ---------------------------------------------------------------------------
--
-- Rules (version 1). Only finished weeks (before the current greenhouse week
-- at p_as_of) are judged, except stale_status, which describes the present.
--
--   incomplete_visit (week, coverage)
--       Some stems were visited, but fewer than 90% of the expected stems.
--   missed_stem_visit (stem-week, coverage)
--       Coverage was at least 90%, but this expected stem has no evidence.
--   harvest_not_recorded (week, possible_recording_error)
--       On visited stems, at least 10 fruit were at Breaker at the start of
--       the week, and the share first recorded Harvested that week is below
--       half the crop's usual share (median of earlier weeks with at least 10
--       breakers; a cautious 0.60 until three such weeks exist, so the slow
--       first harvest weeks of a crop aren't flagged).
--   stage_regression (node, possible_recording_error)
--       A later week records an earlier stage (Flower < SetFruit <
--       MatureGreen < BreakerFruit < Harvested). Aborted/Pruned are not stages.
--   harvest_without_ripening (node, possible_recording_error)
--       Recorded Harvested with no earlier MatureGreen or BreakerFruit record.
--   stale_status (node, possible_recording_error)
--       Still SetFruit after 10 weeks, MatureGreen after 6 or BreakerFruit
--       after 4, counted from the week of that status to the stem's latest
--       visit (so a stem that wasn't visited can't make its fruit stale).
--   unusual_weekly_count (week, unusual_crop_event)
--       New sets, breakers or harvests per visited stem outside the median of
--       the previous 8 judged weeks ± max(4 × MAD, 50% of the median, 0.5
--       per stem). Needs 5 earlier weeks in which that stage already
--       occurred, so the start of breakers or harvests isn't "unusual".
--       May well be biological.
--
-- Output: flag_key, rule_id, rule_version, category, scope, yw, week_start,
-- measurement_stem_id, plant_node_id, title, explanation, evidence, and the
-- latest review by p_as_of (review_decision null = never reviewed).

create or replace function public.crop_quality_flags(p_crop_id uuid, p_as_of timestamptz default now())
returns table (
  flag_key             text,
  rule_id              text,
  rule_version         integer,
  category             text,
  scope                text,
  yw                   integer,
  week_start           date,
  measurement_stem_id  uuid,
  plant_node_id        uuid,
  title                text,
  explanation          text,
  evidence             jsonb,
  review_decision      text,
  review_note          text,
  reviewed_at          timestamptz,
  reviewed_by          uuid
)
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
  stem_first as (
    select measurement_stem_id as stem, min(week_start) as first_ws from stem_weeks group by 1
  ),
  -- Finished weeks from the first visit to the week before the current one.
  weeks as (
    select (select min(first_ws) from stem_first) as ws
    union all
    select ws + 7 from weeks where ws + 7 < (select week_start from current_week)
  ),
  judged as (
    select w.ws,
           extract(isoyear from w.ws)::integer * 100 + extract(week from w.ws)::integer as yw,
           (select count(*) from stem_first f where f.first_ws <= w.ws)::integer as expected,
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
                                 from stem_first f
                                 join public.measurement_stems ms on ms.id = f.stem
                                 join public.measurement_rows r on r.id = ms.measurement_row_id
                                 where f.first_ws <= j.ws and not exists (select 1 from stem_weeks s where s.measurement_stem_id = f.stem and s.week_start = j.ws))) as evidence
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
    join stem_first f on f.first_ws <= j.ws
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

revoke execute on function public.crop_quality_flags(uuid, timestamptz) from public, anon;
grant  execute on function public.crop_quality_flags(uuid, timestamptz) to authenticated;
