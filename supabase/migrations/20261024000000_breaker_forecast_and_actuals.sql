-- Plants: Breaker-based next-week forecast, forecast basis per variety and
-- week, and manually entered actual harvested kg.
--
-- Approved 2026-10-16. Until full lifecycle recording resumes with the 2027
-- crop, the Friday walkthrough records only Breakers (a Breaker still on the
-- plant is recorded again on the same node). This migration adds:
--
--   forecast_basis_settings   per variety, from a week on: 'lifecycle' (the
--                             eight-week stage forecast) or 'breaker_only'
--                             (next week from that Friday's Breakers × the
--                             harvest-ready share). Append-only: a change is a
--                             new row; the row with the latest start week at
--                             or before a week is in effect (ties: the newest).
--   forecast_basis_at()       the basis in effect for a variety and week
--   weekly_harvest_actuals    actual kg harvested per variety and week, entered
--                             by hand. Append-only: a correction is a new row,
--                             the newest per week is in effect, null clears it.
--   forecast_runs             + basis, harvest-ready share, Breaker breakdown
--                             and stem coverage; weeks a basis can't support
--                             are stored as not available (no numbers).
--   lock_forecast_run()       stores those; refuses a week whose readiness isn't
--                             'ready'.
--   forecast_lock_readiness() + 'incomplete': an official forecast is locked
--                             only when every sampled stem was checked by the
--                             time sampling was marked complete.
--   crop_quality_flags()      lifecycle-only rules (harvest not recorded,
--                             stale status, unusual counts, long development)
--                             are left out for weeks recorded Breakers-only;
--                             the full set stays in crop_quality_flags_all().
--
-- Nothing existing is changed or removed: observations, photos, AFW, locked
-- forecasts and their weeks keep their values.

-- ---------------------------------------------------------------------------
-- Forecast basis
-- ---------------------------------------------------------------------------

create table public.forecast_basis_settings (
  id                   uuid primary key default gen_random_uuid(),
  organization_id      uuid not null,
  crop_id              uuid not null,
  from_year            integer not null,
  from_week            integer not null,
  basis                text not null check (basis in ('lifecycle', 'breaker_only')),
  -- Share of a Friday's Breakers expected to be harvested the following week (Breakers only).
  harvest_ready_share  numeric(4, 3) check (harvest_ready_share is null or (harvest_ready_share >= 0.05 and harvest_ready_share <= 1)),
  note                 text check (char_length(note) <= 500),
  created_at           timestamptz not null default now(),
  created_by           uuid default auth.uid(),
  constraint forecast_basis_settings_crop_fkey
    foreign key (organization_id, crop_id)
    references public.crops (organization_id, id) on delete restrict,
  constraint forecast_basis_settings_week_check
    check (from_week between 1 and public.iso_weeks_in_year(from_year)),
  constraint forecast_basis_settings_share_check
    check ((basis = 'breaker_only') = (harvest_ready_share is not null))
);

create index forecast_basis_settings_crop_idx on public.forecast_basis_settings (crop_id, from_year, from_week, created_at);

comment on table public.forecast_basis_settings is
  'Append-only: what a variety''s forecast rests on from a week on (lifecycle / breaker_only) and, for Breakers only, the harvest-ready share. In effect at a week: the row with the latest start week at or before it (ties: the newest).';

-- ---------------------------------------------------------------------------
-- Actual harvested kg
-- ---------------------------------------------------------------------------

create table public.weekly_harvest_actuals (
  id               bigint generated always as identity primary key,
  organization_id  uuid not null,
  crop_id          uuid not null,
  year             integer not null,
  week             integer not null,
  -- Null: the week's value was cleared (not entered).
  actual_kg        numeric(12, 2) check (actual_kg is null or (actual_kg >= 0 and actual_kg < 100000000)),
  note             text check (char_length(note) <= 500),
  entered_at       timestamptz not null default now(),
  entered_by       uuid default auth.uid(),
  constraint weekly_harvest_actuals_crop_fkey
    foreign key (organization_id, crop_id)
    references public.crops (organization_id, id) on delete restrict,
  constraint weekly_harvest_actuals_week_check
    check (week between 1 and public.iso_weeks_in_year(year))
);

create index weekly_harvest_actuals_crop_idx on public.weekly_harvest_actuals (crop_id, year, week, entered_at desc, id desc);

comment on table public.weekly_harvest_actuals is
  'Append-only: actual kilograms harvested per variety and week, entered by hand. The newest row per week is in effect; earlier rows are its correction history. Null kg clears the week.';

-- Who and when are set by the server, never by the client.
create or replace function public.stamp_entry()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_table_name = 'weekly_harvest_actuals' then
    new.entered_at := now();
    new.entered_by := auth.uid();
  else
    new.created_at := now();
    new.created_by := auth.uid();
  end if;
  return new;
end;
$$;

revoke execute on function public.stamp_entry() from public, anon, authenticated;

create trigger weekly_harvest_actuals_stamp before insert on public.weekly_harvest_actuals
  for each row execute function public.stamp_entry();
create trigger forecast_basis_settings_stamp before insert on public.forecast_basis_settings
  for each row execute function public.stamp_entry();

-- Defence in depth: history is never changed or removed (also for the table owner's API roles).
create trigger weekly_harvest_actuals_immutable before update or delete on public.weekly_harvest_actuals
  for each row execute function public.forecast_runs_immutable();
create trigger forecast_basis_settings_immutable before update or delete on public.forecast_basis_settings
  for each row execute function public.forecast_runs_immutable();

alter table public.weekly_harvest_actuals enable row level security;
alter table public.forecast_basis_settings enable row level security;

create policy "Members can read actual harvest"
  on public.weekly_harvest_actuals for select to authenticated
  using (public.is_org_member(organization_id));
create policy "Members can enter actual harvest"
  on public.weekly_harvest_actuals for insert to authenticated
  with check (public.is_org_member(organization_id));
create policy "Members can read forecast settings"
  on public.forecast_basis_settings for select to authenticated
  using (public.is_org_member(organization_id));
create policy "Members can change forecast settings"
  on public.forecast_basis_settings for insert to authenticated
  with check (public.is_org_member(organization_id));

revoke all on public.weekly_harvest_actuals, public.forecast_basis_settings from anon, authenticated;
grant select, insert on public.weekly_harvest_actuals, public.forecast_basis_settings to authenticated;
grant select on public.weekly_harvest_actuals, public.forecast_basis_settings to service_role;

-- The basis in effect for a variety and week (as recorded by p_as_of); no row when none is set.
create or replace function public.forecast_basis_at(p_crop_id uuid, p_yw integer, p_as_of timestamptz default now())
returns table (basis text, harvest_ready_share numeric, from_year integer, from_week integer)
language sql
stable
security invoker
set search_path = ''
as $$
  select s.basis, s.harvest_ready_share, s.from_year, s.from_week
  from public.forecast_basis_settings s
  where s.crop_id = p_crop_id and s.from_year * 100 + s.from_week <= p_yw and s.created_at <= p_as_of
  order by s.from_year desc, s.from_week desc, s.created_at desc, s.id desc
  limit 1
$$;

revoke execute on function public.forecast_basis_at(uuid, integer, timestamptz) from public, anon;
grant  execute on function public.forecast_basis_at(uuid, integer, timestamptz) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Data-quality flags: lifecycle-only rules don't apply to Breakers-only weeks
-- ---------------------------------------------------------------------------
--
-- With only Breakers recorded, harvests, new sets and stage changes aren't
-- recorded either, so these rules would fire every week. They still apply to
-- lifecycle weeks; crop_quality_flags_all() keeps every flag.

alter function public.crop_quality_flags(uuid, timestamptz) rename to crop_quality_flags_all;

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
  select f.*
  from public.crop_quality_flags_all(p_crop_id, p_as_of) f
  where not (
    f.rule_id in ('harvest_not_recorded', 'stale_status', 'unusual_weekly_count', 'long_development')
    and coalesce((select b.basis from public.forecast_basis_at(p_crop_id, f.yw, p_as_of) b), 'lifecycle') = 'breaker_only'
  )
$$;

revoke execute on function public.crop_quality_flags(uuid, timestamptz) from public, anon;
grant  execute on function public.crop_quality_flags(uuid, timestamptz) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Locked forecasts: basis, availability
-- ---------------------------------------------------------------------------

alter table public.forecast_runs
  add column basis text not null default 'lifecycle' check (basis in ('lifecycle', 'breaker_only')),
  add column harvest_ready_share numeric(4, 3),
  -- Breakers only: new / carried over / first seen, and last week's Breakers not recorded again.
  add column breaker_breakdown jsonb,
  -- Stems in the sample checked or recorded that week ÷ stems in the sample.
  add column coverage numeric(5, 4),
  alter column marketing_sample_fruit drop not null,
  alter column marketing_crop_fruit drop not null,
  add constraint forecast_runs_basis_share_check check ((basis = 'breaker_only') = (harvest_ready_share is not null));

alter table public.forecast_run_weeks
  -- false: the basis can't support this week (e.g. Breakers only beyond next week); no numbers are stored.
  add column available boolean not null default true,
  alter column sample_fruit drop not null,
  alter column sample_variance drop not null,
  alter column crop_fruit drop not null,
  alter column components drop not null,
  alter column expected_aborted drop not null,
  alter column expected_pruned drop not null,
  add constraint forecast_run_weeks_available_check
    check (available or (sample_fruit is null and crop_fruit is null and kg is null and cases is null));

-- ---------------------------------------------------------------------------
-- Readiness: every sampled stem checked by completion
-- ---------------------------------------------------------------------------
--
-- ready             the completion is the week's latest event, its stem checks
--                   have reached the server, and every stem in the sample was
--                   checked by the time sampling was marked complete
-- waiting_for_sync  checks seen on the phone haven't all arrived yet
-- incomplete        some sampled stems weren't checked: no official forecast
--                   is locked from it (a preview still shows it, labelled)
-- superseded / locked as before

alter table public.forecast_lock_jobs drop constraint forecast_lock_jobs_status_check;
alter table public.forecast_lock_jobs add constraint forecast_lock_jobs_status_check
  check (status in ('pending', 'waiting_for_sync', 'running', 'retry', 'done', 'superseded', 'incomplete', 'failed'));

create or replace function public.forecast_lock_readiness(p_sampling_event_id uuid)
returns table (state text, checked_in_db integer, checked_seen integer, detail text)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_event public.sampling_week_events;
  v_latest uuid;
  v_checked integer;
  v_checked_by_completion integer;
  v_expected integer;
begin
  select * into v_event from public.sampling_week_events where id = p_sampling_event_id;
  if v_event.id is null
     or not (public.is_org_member(v_event.organization_id) or coalesce(current_setting('request.jwt.claims', true)::jsonb ->> 'role', '') = 'service_role') then
    raise exception 'Sampling completion not found' using errcode = '42501';
  end if;
  if exists (select 1 from public.forecast_runs r where r.crop_id = v_event.crop_id and r.origin_year = v_event.year and r.origin_week = v_event.week_number) then
    return query select 'locked', null::integer, v_event.stems_checked_seen, 'This week already has a locked forecast.';
    return;
  end if;
  select e.id into v_latest from public.sampling_week_events e
   where e.crop_id = v_event.crop_id and e.year = v_event.year and e.week_number = v_event.week_number
   order by e.recorded_at desc, e.id desc limit 1;
  if v_latest <> v_event.id then
    return query select 'superseded', null::integer, v_event.stems_checked_seen, 'Sampling was reopened or completed again after this.';
    return;
  end if;
  -- Stems whose latest check this week says checked (all that have arrived).
  select count(*)::integer into v_checked from (
    select distinct on (v.measurement_stem_id) v.checked
    from public.stem_visits v
    where v.crop_id = v_event.crop_id and v.year = v_event.year and v.week_number = v_event.week_number
    order by v.measurement_stem_id, v.observed_at desc, v.recorded_at desc, v.id desc
  ) latest where latest.checked;
  if v_checked < coalesce(v_event.stems_checked_seen, 0) then
    return query select 'waiting_for_sync', v_checked, v_event.stems_checked_seen,
      format('%s of the %s stem checks seen at completion have reached the server.', v_checked, v_event.stems_checked_seen);
    return;
  end if;
  -- … and of those, checked by the time sampling was marked complete.
  select count(*)::integer into v_checked_by_completion from (
    select distinct on (v.measurement_stem_id) v.checked
    from public.stem_visits v
    where v.crop_id = v_event.crop_id and v.year = v_event.year and v.week_number = v_event.week_number and v.observed_at <= v_event.observed_at
    order by v.measurement_stem_id, v.observed_at desc, v.recorded_at desc, v.id desc
  ) latest where latest.checked;
  -- Stems in the sample that week: first visit evidence in or before it.
  select count(*)::integer into v_expected from (
    select w.measurement_stem_id
    from public.crop_stem_weeks(v_event.crop_id, now()) w
    where w.visited
    group by w.measurement_stem_id
    having min(w.yw) <= v_event.year * 100 + v_event.week_number
  ) s;
  if v_checked_by_completion < v_expected then
    return query select 'incomplete', v_checked_by_completion, v_event.stems_checked_seen,
      format('%s of the %s sampled stems were checked when sampling was marked complete. An official forecast is locked only when every sampled stem is checked.',
             v_checked_by_completion, v_expected);
    return;
  end if;
  return query select 'ready', v_checked, v_event.stems_checked_seen, null::text;
end;
$$;

create or replace function public.claim_forecast_lock_job()
returns setof public.forecast_lock_jobs
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.forecast_lock_jobs;
  v_ready record;
begin
  if coalesce(current_setting('request.jwt.claims', true)::jsonb ->> 'role', '') <> 'service_role' then
    raise exception 'Only the lock worker can claim jobs' using errcode = '42501';
  end if;
  loop
    select * into v_job from public.forecast_lock_jobs j
     where (j.status in ('pending', 'waiting_for_sync', 'retry') and j.next_attempt_at <= now())
        or (j.status = 'running' and j.lease_until < now())
     order by j.next_attempt_at, j.id
     limit 1
     for update skip locked;
    if v_job.id is null then
      return;
    end if;
    select * into v_ready from public.forecast_lock_readiness(v_job.sampling_event_id);
    if v_ready.state = 'superseded' or v_ready.state = 'locked' then
      update public.forecast_lock_jobs set status = case when v_ready.state = 'locked' then 'done' else 'superseded' end,
             last_error = v_ready.detail, lease_until = null, updated_at = now(),
             run_id = (select r.id from public.forecast_runs r where r.crop_id = v_job.crop_id and r.origin_year = v_job.year and r.origin_week = v_job.week),
             run_kind = (select r.kind from public.forecast_runs r where r.crop_id = v_job.crop_id and r.origin_year = v_job.year and r.origin_week = v_job.week)
       where id = v_job.id;
    elsif v_ready.state = 'incomplete' then
      -- Final: checks made after completion don't count; completing again (all stems checked) queues a new job.
      update public.forecast_lock_jobs set status = 'incomplete', last_error = v_ready.detail, lease_until = null, updated_at = now()
       where id = v_job.id;
    elsif v_ready.state = 'waiting_for_sync' then
      update public.forecast_lock_jobs
         set status = case when v_job.created_at < now() - interval '7 days' then 'failed' else 'waiting_for_sync' end,
             last_error = v_ready.detail || case when v_job.created_at < now() - interval '7 days' then ' Gave up after 7 days.' else '' end,
             next_attempt_at = now() + interval '2 minutes', lease_until = null, updated_at = now()
       where id = v_job.id;
    else
      update public.forecast_lock_jobs
         set status = 'running', attempts = attempts + 1, lease_until = now() + interval '10 minutes', updated_at = now()
       where id = v_job.id
       returning * into v_job;
      return next v_job;
      return;
    end if;
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- lock_forecast_run(): + basis, share, breakdown, coverage, availability
-- ---------------------------------------------------------------------------

drop function public.lock_forecast_run(uuid, uuid, integer, integer, uuid, timestamptz, integer, integer, text, text, text[], jsonb, jsonb, integer, uuid[], numeric, jsonb, jsonb);

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
  p_weeks jsonb,
  p_basis text,
  p_harvest_ready_share numeric,
  p_breaker_breakdown jsonb,
  p_coverage numeric
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
  v_ready record;
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
  -- Every sampled stem checked, and the checks arrived.
  select * into v_ready from public.forecast_lock_readiness(v_event.id);
  if v_ready.state <> 'ready' then
    raise exception '%', coalesce(v_ready.detail, 'Sampling is not ready to lock') using errcode = '22023';
  end if;

  if p_basis is null or p_basis not in ('lifecycle', 'breaker_only') or ((p_basis = 'breaker_only') <> (p_harvest_ready_share is not null)) then
    raise exception 'Invalid forecast basis' using errcode = '22023';
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
    if coalesce((v_week ->> 'available')::boolean, true) = false and coalesce(v_week ->> 'sample_fruit', v_week ->> 'crop_fruit', v_week ->> 'kg') is not null then
      raise exception 'Forecast week % is not available but has numbers', v_h using errcode = '22023';
    end if;
  end loop;

  -- On time if locked before Monday 00:00 (Toronto) of the first target week.
  v_first_target := (to_date(p_origin_year || '-' || lpad(p_origin_week::text, 2, '0'), 'IYYY-IW') + 7)::timestamp at time zone 'America/Toronto';
  v_kind := case when v_now < v_first_target then 'official' else 'late' end;

  insert into public.forecast_runs (
    id, organization_id, crop_id, origin_year, origin_week, kind, sampling_event_id, observed_cutoff, recorded_cutoff,
    locked_at, locked_by, first_target_starts, horizon, marketing_weeks, engine_version, confidence, confidence_reasons,
    model, data_summary, sample_stems, sample_stem_ids, scale, case_weight_kg, marketing_sample_fruit, marketing_crop_fruit, marketing_kg,
    basis, harvest_ready_share, breaker_breakdown, coverage
  ) values (
    p_run_id, v_crop.organization_id, p_crop_id, p_origin_year, p_origin_week, v_kind, v_event.id, v_event.observed_at, p_recorded_cutoff,
    v_now, (select auth.uid()), v_first_target, p_horizon, p_marketing_weeks, p_engine_version, p_confidence, coalesce(p_confidence_reasons, '{}'),
    p_model, p_data_summary, p_sample_stems, p_sample_stem_ids, p_scale, v_crop.case_weight_kg,
    (p_marketing ->> 'sample_fruit')::numeric, (p_marketing ->> 'crop_fruit')::numeric, (p_marketing ->> 'kg')::numeric,
    p_basis, p_harvest_ready_share, p_breaker_breakdown, p_coverage
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
    run_id, horizon, target_year, target_week, "window", available, sample_fruit, sample_variance, crop_fruit, components,
    expected_aborted, expected_pruned, afw_g, afw_source, afw_kind, kg, cases
  )
  select p_run_id, (w ->> 'horizon')::integer, (w ->> 'target_year')::integer, (w ->> 'target_week')::integer, w ->> 'window',
         coalesce((w ->> 'available')::boolean, true),
         (w ->> 'sample_fruit')::numeric, (w ->> 'sample_variance')::numeric, (w ->> 'crop_fruit')::numeric, w -> 'components',
         (w ->> 'expected_aborted')::numeric, (w ->> 'expected_pruned')::numeric, (w ->> 'afw_g')::numeric, w ->> 'afw_source', w ->> 'afw_kind', (w ->> 'kg')::numeric,
         case when v_crop.case_weight_kg is not null and (w ->> 'kg') is not null then (w ->> 'kg')::numeric / v_crop.case_weight_kg end
  from jsonb_array_elements(p_weeks) w;

  return query select p_run_id, v_kind, true, v_now;
end;
$$;

revoke execute on function public.lock_forecast_run(uuid, uuid, integer, integer, uuid, timestamptz, integer, integer, text, text, text[], jsonb, jsonb, integer, uuid[], numeric, jsonb, jsonb, text, numeric, jsonb, numeric) from public, anon;
grant  execute on function public.lock_forecast_run(uuid, uuid, integer, integer, uuid, timestamptz, integer, integer, text, text, text[], jsonb, jsonb, integer, uuid[], numeric, jsonb, jsonb, text, numeric, jsonb, numeric) to authenticated, service_role;
