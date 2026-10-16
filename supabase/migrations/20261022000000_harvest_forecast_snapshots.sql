-- Plants: Harvest Forecast snapshots (Stage 3)
--
-- Additive only. Nothing here changes or deletes an existing record.
--
--   crops.case_weight_kg        configurable kg per case (null = cases not shown)
--   weekly_harvest_afw_log      append-only history of every AFW change, so a
--                               forecast's AFW inputs can be reconstructed as
--                               they stood at its cutoff
--   forecast_runs               one locked eight-week forecast per crop and
--   forecast_run_weeks          sampling week: never updated, never deleted
--   lock_forecast_run(...)      the only way to store a forecast; the server
--                               decides whether it is on time
--   crop_quality_flags()        + rule long_development
--
-- Locking rules (approved 2026-10-15):
--   * A forecast is locked only for a sampling week marked complete
--     (latest sampling_week_events record = 'completed'). Its observations
--     are those observed by that completion and stored by the lock.
--   * Locked before the first target week (origin + 1) begins, Monday 00:00
--     America/Toronto, by server time → kind 'official'. Locked later →
--     kind 'late': kept and shown, never treated as on time.
--   * One forecast per crop and sampling week. A second attempt (another
--     device, a retry, sampling reopened and completed again) returns the
--     existing run and stores nothing: an official forecast is never
--     overwritten or recalculated.
--   * Previews ("Generate forecast") are computed in the app and not stored.
--
-- Auditability: each run stores the engine version, its parameters, both
-- cutoffs, the sampled stems it covers, each week's AFW and whether it was
-- the grower's or the model's, the completion it was locked from, a summary of the data it used
-- (training examples by data tier, flags applied and their review decisions,
-- inventory, AFW source) and every week's components.

-- ---------------------------------------------------------------------------
-- Case weight
-- ---------------------------------------------------------------------------

alter table public.crops
  add column case_weight_kg numeric(6, 2) check (case_weight_kg is null or (case_weight_kg > 0 and case_weight_kg <= 100));

comment on column public.crops.case_weight_kg is 'Kilograms per case, for showing forecasts in cases. Null: cases not shown.';

-- ---------------------------------------------------------------------------
-- AFW change log
-- ---------------------------------------------------------------------------

create table public.weekly_harvest_afw_log (
  id               bigint generated always as identity primary key,
  organization_id  uuid not null,
  crop_id          uuid not null,
  year             integer not null,
  week             integer not null,
  -- null: the value was cleared.
  afw_g            numeric(6, 1),
  action           text not null check (action in ('baseline', 'set', 'clear')),
  logged_at        timestamptz not null default now(),
  logged_by        uuid default auth.uid(),
  constraint weekly_harvest_afw_log_crop_fkey
    foreign key (organization_id, crop_id)
    references public.crops (organization_id, id) on delete cascade
);

create index weekly_harvest_afw_log_crop_idx on public.weekly_harvest_afw_log (crop_id, year, week, logged_at desc);

comment on table public.weekly_harvest_afw_log is
  'Append-only history of weekly_harvest_afw. ''baseline'' rows record the values that existed when logging began (their logged_at is that moment, not when they were typed).';

create or replace function public.weekly_harvest_afw_log_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    insert into public.weekly_harvest_afw_log (organization_id, crop_id, year, week, afw_g, action)
    values (old.organization_id, old.crop_id, old.year, old.week, null, 'clear');
    return old;
  end if;
  if tg_op = 'UPDATE' and new.afw_g is not distinct from old.afw_g then
    return new;
  end if;
  insert into public.weekly_harvest_afw_log (organization_id, crop_id, year, week, afw_g, action)
  values (new.organization_id, new.crop_id, new.year, new.week, new.afw_g, 'set');
  return new;
end;
$$;

create trigger weekly_harvest_afw_log_change
  after insert or update or delete on public.weekly_harvest_afw
  for each row execute function public.weekly_harvest_afw_log_change();

revoke execute on function public.weekly_harvest_afw_log_change() from public, anon, authenticated;

-- The values that exist now, as the log's starting point.
insert into public.weekly_harvest_afw_log (organization_id, crop_id, year, week, afw_g, action, logged_by)
select organization_id, crop_id, year, week, afw_g, 'baseline', null
from public.weekly_harvest_afw;

alter table public.weekly_harvest_afw_log enable row level security;
create policy "Members can read the AFW log"
  on public.weekly_harvest_afw_log for select to authenticated
  using (public.is_org_member(organization_id));
revoke all on public.weekly_harvest_afw_log from anon, authenticated;
grant select on public.weekly_harvest_afw_log to authenticated;

-- ---------------------------------------------------------------------------
-- Forecast runs
-- ---------------------------------------------------------------------------

create table public.forecast_runs (
  id                    uuid primary key,
  organization_id       uuid not null,
  crop_id               uuid not null,
  origin_year           integer not null,
  origin_week           integer not null,
  -- 'official': locked before the first target week began; 'late': after.
  kind                  text not null check (kind in ('official', 'late')),
  -- The completion it was locked from, and the cutoffs of its inputs.
  sampling_event_id     uuid not null references public.sampling_week_events (id),
  observed_cutoff       timestamptz not null,
  recorded_cutoff       timestamptz not null,
  locked_at             timestamptz not null default now(),
  locked_by             uuid default auth.uid(),
  first_target_starts   timestamptz not null,
  horizon               integer not null check (horizon between 1 and 26),
  marketing_weeks       integer not null check (marketing_weeks between 1 and horizon),
  engine_version        text not null check (char_length(engine_version) between 1 and 40),
  -- 'experimental' while the model rests mostly on unverified history or no horizon is validated.
  confidence            text not null check (confidence in ('experimental', 'standard')),
  confidence_reasons    text[] not null default '{}',
  model                 jsonb not null,
  data_summary          jsonb not null,
  sample_stems          integer not null check (sample_stems >= 0),
  -- The sampled stems the forecast covers: observed harvests are counted on exactly these.
  sample_stem_ids       uuid[] not null,
  scale                 numeric not null check (scale >= 0),
  case_weight_kg        numeric(6, 2),
  marketing_sample_fruit numeric not null,
  marketing_crop_fruit  numeric not null,
  marketing_kg          numeric,
  constraint forecast_runs_crop_fkey
    foreign key (organization_id, crop_id)
    references public.crops (organization_id, id) on delete restrict,
  constraint forecast_runs_iso_week_check
    check (origin_week between 1 and public.iso_weeks_in_year(origin_year)),
  constraint forecast_runs_crop_week_key unique (crop_id, origin_year, origin_week)
);

create index forecast_runs_crop_idx on public.forecast_runs (crop_id, origin_year desc, origin_week desc);

comment on table public.forecast_runs is
  'Locked harvest forecasts, one per crop and sampling week. Insert-only through lock_forecast_run(); never updated or deleted.';

create table public.forecast_run_weeks (
  run_id            uuid not null references public.forecast_runs (id) on delete restrict,
  horizon           integer not null check (horizon between 1 and 26),
  target_year       integer not null,
  target_week       integer not null,
  "window"          text not null check ("window" in ('marketing', 'outlook')),
  sample_fruit      numeric not null check (sample_fruit >= 0),
  sample_variance   numeric not null check (sample_variance >= 0),
  crop_fruit        numeric not null check (crop_fruit >= 0),
  components        jsonb not null,
  expected_aborted  numeric not null,
  expected_pruned   numeric not null,
  afw_g             numeric,
  afw_source        text,
  -- 'grower': the AFW the grower entered for that week; 'model': estimated.
  afw_kind          text check (afw_kind in ('grower', 'model')),
  kg                numeric,
  cases             numeric,
  primary key (run_id, horizon)
);

comment on table public.forecast_run_weeks is 'The weeks of a locked forecast (weeks 1–5: marketing window; 6–8: outlook). Never updated or deleted.';

alter table public.forecast_runs enable row level security;
alter table public.forecast_run_weeks enable row level security;

create policy "Members can read forecasts"
  on public.forecast_runs for select to authenticated
  using (public.is_org_member(organization_id));
create policy "Members can read forecast weeks"
  on public.forecast_run_weeks for select to authenticated
  using (exists (select 1 from public.forecast_runs r where r.id = run_id and public.is_org_member(r.organization_id)));

-- Read only for clients: runs are stored by lock_forecast_run().
revoke all on public.forecast_runs, public.forecast_run_weeks from anon, authenticated;
grant select on public.forecast_runs, public.forecast_run_weeks to authenticated;

-- Defence in depth: no role can change or remove a locked forecast.
create or replace function public.forecast_runs_immutable()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'Locked forecasts cannot be changed or deleted' using errcode = '42501';
end;
$$;

create trigger forecast_runs_immutable before update or delete on public.forecast_runs
  for each row execute function public.forecast_runs_immutable();
create trigger forecast_run_weeks_immutable before update or delete on public.forecast_run_weeks
  for each row execute function public.forecast_runs_immutable();

-- ---------------------------------------------------------------------------
-- lock_forecast_run()
-- ---------------------------------------------------------------------------
--
-- Stores a forecast computed by the app's engine for a completed sampling
-- week, or returns the forecast already stored for that week (stored_now =
-- false). The server checks membership, the completion, the cutoffs and the
-- weeks' shape, and decides official / late by its own clock.

create or replace function public.lock_forecast_run(
  p_run_id uuid,
  p_crop_id uuid,
  p_origin_year integer,
  p_origin_week integer,
  p_sampling_event_id uuid,
  p_recorded_cutoff timestamptz,
  p_horizon integer,
  p_marketing_weeks integer,
  p_engine_version text,
  p_confidence text,
  p_confidence_reasons text[],
  p_model jsonb,
  p_data_summary jsonb,
  p_sample_stems integer,
  p_sample_stem_ids uuid[],
  p_scale numeric,
  p_marketing jsonb,
  p_weeks jsonb
)
returns table (run_id uuid, kind text, stored_now boolean, locked_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_crop public.crops;
  v_event public.sampling_week_events;
  v_existing public.forecast_runs;
  v_first_target timestamptz;
  v_kind text;
  v_now timestamptz := now();
  v_week jsonb;
  v_h integer;
  v_window text;
begin
  select * into v_crop from public.crops where id = p_crop_id;
  -- A member of the crop's organization, or the server-side lock worker (service role).
  if v_crop.id is null or not (public.is_org_member(v_crop.organization_id) or coalesce(current_setting('request.jwt.claims', true)::jsonb ->> 'role', '') = 'service_role') then
    raise exception 'Crop not found' using errcode = '42501';
  end if;

  -- Already locked for this week: return it, store nothing.
  select * into v_existing from public.forecast_runs r
   where r.crop_id = p_crop_id and r.origin_year = p_origin_year and r.origin_week = p_origin_week;
  if v_existing.id is not null then
    return query select v_existing.id, v_existing.kind, false, v_existing.locked_at;
    return;
  end if;

  -- The week's sampling must be complete, and the run must come from its latest completion.
  select * into v_event from public.sampling_week_events e
   where e.crop_id = p_crop_id and e.year = p_origin_year and e.week_number = p_origin_week
   order by e.recorded_at desc, e.id desc limit 1;
  if v_event.id is null or v_event.event <> 'completed' then
    raise exception 'Sampling for %-W% is not marked complete', p_origin_year, p_origin_week using errcode = '22023';
  end if;
  if v_event.id <> p_sampling_event_id then
    raise exception 'The forecast was not computed from the latest sampling completion' using errcode = '22023';
  end if;
  if p_recorded_cutoff > v_now or p_recorded_cutoff < v_event.recorded_at then
    raise exception 'Invalid data cutoff' using errcode = '22023';
  end if;

  -- Shape: horizons 1 … p_horizon, consecutive weeks after the origin.
  if coalesce(cardinality(p_sample_stem_ids), 0) <> p_sample_stems then
    raise exception 'Sampled stems don''t match their count' using errcode = '22023';
  end if;
  if p_horizon < 1 or p_marketing_weeks < 1 or p_marketing_weeks > p_horizon or jsonb_array_length(p_weeks) <> p_horizon then
    raise exception 'Forecast weeks don''t match the horizon' using errcode = '22023';
  end if;
  for v_week in select * from jsonb_array_elements(p_weeks) loop
    v_h := (v_week ->> 'horizon')::integer;
    v_window := case when v_h <= p_marketing_weeks then 'marketing' else 'outlook' end;
    if v_h is null or v_h < 1 or v_h > p_horizon
       or to_date((v_week ->> 'target_year') || '-' || lpad(v_week ->> 'target_week', 2, '0'), 'IYYY-IW')
          <> to_date(p_origin_year || '-' || lpad(p_origin_week::text, 2, '0'), 'IYYY-IW') + 7 * v_h
       or (v_week ->> 'window') is distinct from v_window then
      raise exception 'Forecast week % is inconsistent', v_h using errcode = '22023';
    end if;
  end loop;

  -- On time if locked before Monday 00:00 (Toronto) of the first target week.
  v_first_target := (to_date(p_origin_year || '-' || lpad(p_origin_week::text, 2, '0'), 'IYYY-IW') + 7)::timestamp at time zone 'America/Toronto';
  v_kind := case when v_now < v_first_target then 'official' else 'late' end;

  insert into public.forecast_runs (
    id, organization_id, crop_id, origin_year, origin_week, kind, sampling_event_id, observed_cutoff, recorded_cutoff,
    locked_at, locked_by, first_target_starts, horizon, marketing_weeks, engine_version, confidence, confidence_reasons,
    model, data_summary, sample_stems, sample_stem_ids, scale, case_weight_kg, marketing_sample_fruit, marketing_crop_fruit, marketing_kg
  ) values (
    p_run_id, v_crop.organization_id, p_crop_id, p_origin_year, p_origin_week, v_kind, v_event.id, v_event.observed_at, p_recorded_cutoff,
    v_now, (select auth.uid()), v_first_target, p_horizon, p_marketing_weeks, p_engine_version, p_confidence, coalesce(p_confidence_reasons, '{}'),
    p_model, p_data_summary, p_sample_stems, p_sample_stem_ids, p_scale, v_crop.case_weight_kg,
    (p_marketing ->> 'sample_fruit')::numeric, (p_marketing ->> 'crop_fruit')::numeric, (p_marketing ->> 'kg')::numeric
  )
  on conflict (crop_id, origin_year, origin_week) do nothing;

  if not found then
    -- Another device locked it a moment earlier.
    select * into v_existing from public.forecast_runs r
     where r.crop_id = p_crop_id and r.origin_year = p_origin_year and r.origin_week = p_origin_week;
    return query select v_existing.id, v_existing.kind, false, v_existing.locked_at;
    return;
  end if;

  insert into public.forecast_run_weeks (
    run_id, horizon, target_year, target_week, "window", sample_fruit, sample_variance, crop_fruit, components,
    expected_aborted, expected_pruned, afw_g, afw_source, afw_kind, kg, cases
  )
  select p_run_id, (w ->> 'horizon')::integer, (w ->> 'target_year')::integer, (w ->> 'target_week')::integer, w ->> 'window',
         (w ->> 'sample_fruit')::numeric, (w ->> 'sample_variance')::numeric, (w ->> 'crop_fruit')::numeric, coalesce(w -> 'components', '{}'::jsonb),
         (w ->> 'expected_aborted')::numeric, (w ->> 'expected_pruned')::numeric, (w ->> 'afw_g')::numeric, w ->> 'afw_source', w ->> 'afw_kind', (w ->> 'kg')::numeric,
         case when v_crop.case_weight_kg is not null and (w ->> 'kg') is not null then (w ->> 'kg')::numeric / v_crop.case_weight_kg end
  from jsonb_array_elements(p_weeks) w;

  return query select p_run_id, v_kind, true, v_now;
end;
$$;

revoke execute on function public.lock_forecast_run(uuid, uuid, integer, integer, uuid, timestamptz, integer, integer, text, text, text[], jsonb, jsonb, integer, uuid[], numeric, jsonb, jsonb) from public, anon;
grant  execute on function public.lock_forecast_run(uuid, uuid, integer, integer, uuid, timestamptz, integer, integer, text, text, text[], jsonb, jsonb, integer, uuid[], numeric, jsonb, jsonb) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- crop_quality_flags(): + long_development (version 1)
-- ---------------------------------------------------------------------------
--
--   long_development (node, possible_recording_error)
--       Recorded Harvested more than 10 weeks after it was first recorded as
--       fruit (the +10 cohort window). Possibly a slow fruit, possibly a node
--       mix-up (two peppers' records on one node) or a missed update. Never
--       excluded automatically: confirmed as a recording error by a person,
--       the node stays out of the model's training; dismissed as legitimate,
--       it counts as real biology.
-- Every other rule is unchanged (20261020000000_sampling_visits_and_quality.sql).

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

