-- Revised official forecasts: Ready % can change until the sampling week ends
--
-- Approved 2026-10-23. A Breakers-only official forecast is locked as soon as
-- a week's sampling is marked complete; its Ready % (harvest-ready share) may
-- still be revised until that sampling week ends: Monday 00:00 greenhouse time
-- (America/Toronto) of the week it forecasts, the run's first_target_starts.
-- From then on the week is final.
--
-- A revision never edits the locked forecast: it is a new forecast_runs row
-- (revision 2, 3, …, linked to the version it replaces by revises_run_id)
-- with its own forecast_run_weeks, locked_at and locked_by. Every earlier
-- version stays as it was (forecast_runs_immutable still blocks updates and
-- deletes). Which version counts is explicit everywhere: the latest revision
-- of the sampling week (the newest saved before the target week begins, and a
-- revision is only accepted before then).
--
-- The revision is computed here, from the locked version's own stored counts,
-- not sent by the browser: next week = share × that week's Breakers × scale
-- peppers, × the stored AFW for kg, ÷ the stored case weight for cases (the
-- engine's Breakers-only formula, engine/breaker.ts). Nothing else changes:
-- data cutoffs, sampled stems, AFW, coverage, kind (official / late) and the
-- weeks the basis can't support. The chosen share is also recorded as that
-- week's Ready % (forecast_basis_settings), as when it is chosen before
-- generating.
--
-- Changes:
--   forecast_runs              + revision (1 = the locked original),
--                                revises_run_id, revision_note; unique per
--                                crop, sampling week and revision (was: per
--                                crop and sampling week)
--   lock_forecast_run()        unchanged behaviour; finds the existing week by
--                              its latest revision, inserts revision 1
--   claim_forecast_lock_job()  run_id of an already-locked week: its latest revision
--   revise_official_forecast() new: members only, before the deadline
-- Existing rows get revision 1 (a constant default: no row is rewritten).

alter table public.forecast_runs
  add column revision        integer not null default 1 check (revision >= 1),
  add column revises_run_id  uuid references public.forecast_runs (id) on delete restrict,
  add column revision_note   text check (char_length(revision_note) <= 500);

alter table public.forecast_runs
  add constraint forecast_runs_revision_link_check check ((revision = 1) = (revises_run_id is null));

alter table public.forecast_runs drop constraint forecast_runs_crop_week_key;
alter table public.forecast_runs add constraint forecast_runs_crop_week_revision_key unique (crop_id, origin_year, origin_week, revision);

comment on column public.forecast_runs.revision is 'Version of the sampling week''s official forecast: 1 = locked at completion, 2+ = Ready % revised before the week ended. The latest counts; all are kept.';

-- ---------------------------------------------------------------------------
-- lock_forecast_run(): the week's existing forecast is its latest revision
-- ---------------------------------------------------------------------------
create or replace function public.lock_forecast_run(p_run_id uuid, p_crop_id uuid, p_origin_year integer, p_origin_week integer, p_sampling_event_id uuid, p_recorded_cutoff timestamp with time zone, p_horizon integer, p_marketing_weeks integer, p_engine_version text, p_confidence text, p_confidence_reasons text[], p_model jsonb, p_data_summary jsonb, p_sample_stems integer, p_sample_stem_ids uuid[], p_scale numeric, p_marketing jsonb, p_weeks jsonb, p_basis text, p_harvest_ready_share numeric, p_breaker_breakdown jsonb, p_coverage numeric)
returns table (run_id uuid, kind text, stored_now boolean, locked_at timestamp with time zone)
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

  -- Already locked for this week: return it (its latest revision), store nothing.
  select * into v_existing from public.forecast_runs r
   where r.crop_id = p_crop_id and r.origin_year = p_origin_year and r.origin_week = p_origin_week
   order by r.revision desc limit 1;
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
  on conflict (crop_id, origin_year, origin_week, revision) do nothing;

  if not found then
    -- Another device locked it a moment earlier.
    select * into v_existing from public.forecast_runs r
     where r.crop_id = p_crop_id and r.origin_year = p_origin_year and r.origin_week = p_origin_week
     order by r.revision desc limit 1;
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

-- ---------------------------------------------------------------------------
-- claim_forecast_lock_job(): an already-locked week reports its latest revision
-- ---------------------------------------------------------------------------
create or replace function public.claim_forecast_lock_job()
returns setof public.forecast_lock_jobs
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.forecast_lock_jobs;
  v_ready record;
  v_run public.forecast_runs;
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
      select * into v_run from public.forecast_runs r
       where r.crop_id = v_job.crop_id and r.origin_year = v_job.year and r.origin_week = v_job.week
       order by r.revision desc limit 1;
      update public.forecast_lock_jobs set status = case when v_ready.state = 'locked' then 'done' else 'superseded' end,
             last_error = v_ready.detail, lease_until = null, updated_at = now(),
             run_id = v_run.id,
             run_kind = v_run.kind
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
-- revise_official_forecast(): publish a revised Ready % for a locked week
-- ---------------------------------------------------------------------------
-- p_run_id: any version of the sampling week's forecast (the latest is revised).
-- Returns the new revision, or the latest one unchanged when the share is the
-- same (stored_now false). Refused after the sampling week ended, for full
-- lifecycle forecasts, and for shares outside 5–100%.
create or replace function public.revise_official_forecast(p_run_id uuid, p_harvest_ready_share numeric, p_note text default null)
returns table (run_id uuid, revision integer, locked_at timestamptz, stored_now boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_any public.forecast_runs;
  v_latest public.forecast_runs;
  v_new uuid := gen_random_uuid();
  v_now timestamptz := now();
  v_share numeric := round(p_harvest_ready_share, 3);
  v_total numeric;
  v_pct text;
begin
  select * into v_any from public.forecast_runs r where r.id = p_run_id;
  if v_any.id is null or not public.is_org_member(v_any.organization_id) then
    raise exception 'Forecast not found' using errcode = '42501';
  end if;
  -- One revision at a time per variety and sampling week.
  perform pg_advisory_xact_lock(hashtext('forecast_revision:' || v_any.crop_id || ':' || v_any.origin_year || ':' || v_any.origin_week));
  select * into v_latest from public.forecast_runs r
   where r.crop_id = v_any.crop_id and r.origin_year = v_any.origin_year and r.origin_week = v_any.origin_week
   order by r.revision desc limit 1;

  if v_latest.basis <> 'breaker_only' then
    raise exception 'Only Breakers-only forecasts have a Ready %%' using errcode = '22023';
  end if;
  -- The deadline: Monday 00:00 greenhouse time of the forecast week (stored at locking).
  if v_now >= v_latest.first_target_starts then
    raise exception 'The W% % sampling week has ended (% greenhouse time): its official forecast is final',
      v_latest.origin_week, v_latest.origin_year, to_char(v_latest.first_target_starts at time zone 'America/Toronto', 'Dy YYYY-MM-DD HH24:MI')
      using errcode = '22023';
  end if;
  if v_share is null or v_share < 0.05 or v_share > 1 then
    raise exception 'Ready %% must be between 5 and 100' using errcode = '22023';
  end if;
  if v_share = v_latest.harvest_ready_share then
    return query select v_latest.id, v_latest.revision, v_latest.locked_at, false;
    return;
  end if;
  v_total := (v_latest.breaker_breakdown ->> 'total')::numeric;
  if v_total is null then
    raise exception 'This forecast has no Breaker count to revise' using errcode = '22023';
  end if;
  v_pct := trim(trailing '.' from trim(trailing '0' from (100 * v_share)::text));

  insert into public.forecast_runs (
    id, organization_id, crop_id, origin_year, origin_week, kind, sampling_event_id, observed_cutoff, recorded_cutoff,
    locked_at, locked_by, first_target_starts, horizon, marketing_weeks, engine_version, confidence, confidence_reasons,
    model, data_summary, sample_stems, sample_stem_ids, scale, case_weight_kg, marketing_sample_fruit, marketing_crop_fruit, marketing_kg,
    basis, harvest_ready_share, breaker_breakdown, coverage, revision, revises_run_id, revision_note
  )
  select v_new, r.organization_id, r.crop_id, r.origin_year, r.origin_week, r.kind, r.sampling_event_id, r.observed_cutoff, r.recorded_cutoff,
         v_now, (select auth.uid()), r.first_target_starts, r.horizon, r.marketing_weeks, r.engine_version, r.confidence,
         array_prepend(
           format('Revised (version %s): Ready %s%% instead of %s%%; the earlier version is kept.', r.revision + 1, v_pct,
                  trim(trailing '.' from trim(trailing '0' from (100 * r.harvest_ready_share)::text))),
           array(select regexp_replace(x, 'next week = [0-9.]+% of', 'next week = ' || v_pct || '% of') from unnest(r.confidence_reasons) x)
         ),
         r.model, r.data_summary, r.sample_stems, r.sample_stem_ids, r.scale, r.case_weight_kg, r.marketing_sample_fruit, r.marketing_crop_fruit, r.marketing_kg,
         r.basis, v_share,
         jsonb_set(r.breaker_breakdown, '{possibleLaterCrop}', to_jsonb((1 - v_share) * v_total * r.scale)),
         r.coverage, r.revision + 1, r.id, nullif(trim(p_note), '')
  from public.forecast_runs r where r.id = v_latest.id;

  insert into public.forecast_run_weeks (
    run_id, horizon, target_year, target_week, "window", available, sample_fruit, sample_variance, crop_fruit, components,
    expected_aborted, expected_pruned, afw_g, afw_source, afw_kind, kg, cases
  )
  select v_new, w.horizon, w.target_year, w.target_week, w."window", w.available,
         case when w.horizon = 1 and w.available then v_share * v_total else w.sample_fruit end,
         case when w.horizon = 1 and w.available then v_total * v_share * (1 - v_share) else w.sample_variance end,
         case when w.horizon = 1 and w.available then v_share * v_total * r.scale else w.crop_fruit end,
         case when w.horizon = 1 and w.available and w.components is not null then jsonb_set(w.components, '{breaker}', to_jsonb(v_share * v_total)) else w.components end,
         w.expected_aborted, w.expected_pruned, w.afw_g, w.afw_source, w.afw_kind,
         case when w.horizon = 1 and w.available and w.afw_g is not null then v_share * v_total * r.scale * w.afw_g / 1000 else w.kg end,
         case when w.horizon = 1 and w.available and w.afw_g is not null and r.case_weight_kg is not null
              then v_share * v_total * r.scale * w.afw_g / 1000 / r.case_weight_kg else w.cases end
  from public.forecast_run_weeks w
  join public.forecast_runs r on r.id = w.run_id
  where w.run_id = v_latest.id;

  -- The week's Ready % from now on (new previews and settings history), as when chosen before generating.
  insert into public.forecast_basis_settings (organization_id, crop_id, from_year, from_week, basis, harvest_ready_share, note, created_by)
  values (v_latest.organization_id, v_latest.crop_id, v_latest.origin_year, v_latest.origin_week, 'breaker_only', v_share,
          format('Official W%s forecast revised to %s%% (version %s)', v_latest.origin_week, v_pct, v_latest.revision + 1), (select auth.uid()));

  return query select v_new, v_latest.revision + 1, v_now, true;
end;
$$;

revoke execute on function public.revise_official_forecast(uuid, numeric, text) from public, anon;
grant  execute on function public.revise_official_forecast(uuid, numeric, text) to authenticated;
