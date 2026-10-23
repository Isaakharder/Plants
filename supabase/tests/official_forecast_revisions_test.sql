-- 20261107000000_official_forecast_revisions: revised official forecasts.
--
-- Runs inside a transaction that is always rolled back.
-- Prints {"result": "official_forecast_revisions tests passed"} on success.

begin;

-- ── Fixture ──────────────────────────────────────────────────────────────────
-- Crop R (Breakers only): W43 locked at 70%: 100 Breakers, scale 1000, AFW 174 g, 5 kg cases
--   → W44 70 sampled / 70,000 peppers / 12,180 kg / 2,436 cases; W45 not available.
-- A second W42 run whose week has ended, and a full lifecycle W41 run.
insert into auth.users (id, email, aud, role) values
  ('cccccccc-0000-4000-8000-00000000c001', 'rev@example.invalid', 'authenticated', 'authenticated'),
  ('cccccccc-0000-4000-8000-00000000c002', 'outsider@example.invalid', 'authenticated', 'authenticated');
insert into public.organizations (id, name) values ('cccccccc-0000-4000-8000-00000000c0a0', 'Rev Org'), ('cccccccc-0000-4000-8000-00000000c0b0', 'Other Org');
insert into public.organization_members (organization_id, user_id, role) values
  ('cccccccc-0000-4000-8000-00000000c0a0', 'cccccccc-0000-4000-8000-00000000c001', 'member'),
  ('cccccccc-0000-4000-8000-00000000c0b0', 'cccccccc-0000-4000-8000-00000000c002', 'owner');
insert into public.crops (id, organization_id, name, color, planting_date, pullout_date, area_m2, picking_stems, case_weight_kg, pepper_type_id) values
  ('cccccccc-0000-4000-8000-00000000cc01', 'cccccccc-0000-4000-8000-00000000c0a0', 'Crop R', 'red', '2026-01-05', '2026-12-31', 100, 1000, 5, (select t.id from public.pepper_types t where t.organization_id = 'cccccccc-0000-4000-8000-00000000c0a0' and t.key = 'bell'));

create function pg_temp.run(id text, week integer, basis text, share numeric, deadline timestamptz) returns void language sql as $$
  insert into public.sampling_week_events (id, organization_id, crop_id, year, week_number, event, observed_at, recorded_at)
  values (id::uuid, 'cccccccc-0000-4000-8000-00000000c0a0', 'cccccccc-0000-4000-8000-00000000cc01', 2026, week, 'completed', now() - interval '1 day', now() - interval '1 day');
  insert into public.forecast_runs (id, organization_id, crop_id, origin_year, origin_week, kind, sampling_event_id, observed_cutoff, recorded_cutoff, locked_at,
    first_target_starts, horizon, marketing_weeks, engine_version, confidence, confidence_reasons, model, data_summary, sample_stems,
    sample_stem_ids, scale, case_weight_kg, basis, harvest_ready_share, breaker_breakdown, coverage)
  values (id::uuid, 'cccccccc-0000-4000-8000-00000000c0a0', 'cccccccc-0000-4000-8000-00000000cc01', 2026, week, 'official', id::uuid, now() - interval '1 day',
    now() - interval '1 day', now() - interval '1 hour', deadline, 2, 1, 'stage-8w-2026.10.3', 'experimental',
    array['Experimental: next week = 70% of this week''s Breakers (harvest-ready share).', 'Weeks 2–8 aren’t available while only Breakers are recorded.'],
    '{}', '{}', 0, '{}', 1000, 5, basis, share,
    case when basis = 'breaker_only' then '{"total": 100, "carriedOver": 0, "new": 100, "firstSeen": 0, "notRecordedAgain": 0, "possibleLaterCrop": 30000}'::jsonb end, 1);
  insert into public.forecast_run_weeks (run_id, horizon, target_year, target_week, "window", available, sample_fruit, sample_variance, crop_fruit,
    components, expected_aborted, expected_pruned, afw_g, afw_source, afw_kind, kg, cases)
  values
    (id::uuid, 1, 2026, week + 1, 'marketing', true, 70, 21, 70000, '{"breaker": 70, "matureGreen": 0, "setFruit": 0, "catchUp": 0, "newSets": 0}', 0, 0, 174, 'W44 grower', 'grower', 12180, 2436),
    (id::uuid, 2, 2026, week + 2, 'outlook', false, null, null, null, null, null, null, null, null, null, null, null);
$$;
select pg_temp.run('cccccccc-0000-4000-8000-0000000c0043', 43, 'breaker_only', 0.7, now() + interval '2 days');   -- this week: still open
select pg_temp.run('cccccccc-0000-4000-8000-0000000c0042', 42, 'breaker_only', 0.7, now() - interval '1 second'); -- ended a second ago
select pg_temp.run('cccccccc-0000-4000-8000-0000000c0041', 41, 'lifecycle', null, now() + interval '2 days');

create temp table original as select r::text as run, (select string_agg(w::text, '|' order by w.horizon) from public.forecast_run_weeks w where w.run_id = r.id) as weeks
  from public.forecast_runs r where r.id = 'cccccccc-0000-4000-8000-0000000c0043';
grant select on original to authenticated;

set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "cccccccc-0000-4000-8000-00000000c001", "role": "authenticated"}', true);

-- ── A revision is a new version, recomputed from the locked numbers ─────────
do $$
declare r record; w record; latest record;
begin
  select * into r from public.revise_official_forecast('cccccccc-0000-4000-8000-0000000c0043', 0.8, 'Picking crew says more are ready');
  if not r.stored_now or r.revision <> 2 then raise exception 'first revision: %', r; end if;
  select * into latest from public.forecast_runs where id = r.run_id;
  if latest.revises_run_id <> 'cccccccc-0000-4000-8000-0000000c0043' or latest.harvest_ready_share <> 0.8 or latest.kind <> 'official'
     or latest.first_target_starts is distinct from (select first_target_starts from public.forecast_runs where id = 'cccccccc-0000-4000-8000-0000000c0043')
     or latest.revision_note <> 'Picking crew says more are ready' or latest.locked_by <> 'cccccccc-0000-4000-8000-00000000c001' then
    raise exception 'revision row: %', latest;
  end if;
  if (latest.breaker_breakdown ->> 'possibleLaterCrop')::numeric <> 20000 then raise exception 'possibleLaterCrop %', latest.breaker_breakdown; end if;
  if latest.confidence_reasons[1] not like 'Revised (version 2): Ready 80% instead of 70%%' or latest.confidence_reasons[2] not like 'Experimental: next week = 80% of%' then
    raise exception 'reasons %', latest.confidence_reasons;
  end if;
  select * into w from public.forecast_run_weeks where run_id = r.run_id and horizon = 1;
  -- 0.8 × 100 = 80 sampled, × 1000 = 80,000 peppers, × 174 g = 13,920 kg, ÷ 5 = 2,784 cases.
  if w.sample_fruit <> 80 or w.crop_fruit <> 80000 or w.kg <> 13920 or w.cases <> 2784 or w.sample_variance <> 16 or (w.components ->> 'breaker')::numeric <> 80 or w.afw_g <> 174 then
    raise exception 'revised week 1: %', w;
  end if;
  select * into w from public.forecast_run_weeks where run_id = r.run_id and horizon = 2;
  if w.available or w.kg is not null then raise exception 'week 2 should stay not available: %', w; end if;
end $$;

-- The locked original is exactly as it was.
do $$
begin
  if (select run from original) <> (select r::text from public.forecast_runs r where r.id = 'cccccccc-0000-4000-8000-0000000c0043')
     or (select weeks from original) <> (select string_agg(w::text, '|' order by w.horizon) from public.forecast_run_weeks w where w.run_id = 'cccccccc-0000-4000-8000-0000000c0043') then
    raise exception 'the original version changed';
  end if;
end $$;

-- ── Several revisions in the same week; the same share changes nothing ──────
do $$
declare r record;
begin
  select * into r from public.revise_official_forecast('cccccccc-0000-4000-8000-0000000c0043', 0.65); -- any version may be passed: the latest is revised
  if r.revision <> 3 or not r.stored_now then raise exception 'second revision: %', r; end if;
  if (select revises_run_id from public.forecast_runs where id = r.run_id) <> (select id from public.forecast_runs where crop_id = 'cccccccc-0000-4000-8000-00000000cc01' and origin_week = 43 and revision = 2) then
    raise exception 'revision 3 must revise revision 2';
  end if;
  select * into r from public.revise_official_forecast(r.run_id, 0.65);
  if r.stored_now or r.revision <> 3 then raise exception 'same share must store nothing: %', r; end if;
  if (select kg from public.forecast_run_weeks where run_id = r.run_id and horizon = 1) <> 0.65 * 100 * 1000 * 174 / 1000 then raise exception 'revision 3 kg'; end if;
  if (select count(*) from public.forecast_runs where crop_id = 'cccccccc-0000-4000-8000-00000000cc01' and origin_week = 43) <> 3 then raise exception 'versions kept'; end if;
  -- The week's Ready % follows the latest revision (one settings entry per revision).
  if (select string_agg(harvest_ready_share::text, ',' order by created_at) from public.forecast_basis_settings where crop_id = 'cccccccc-0000-4000-8000-00000000cc01' and from_week = 43) <> '0.800,0.650' then
    raise exception 'settings: %', (select string_agg(harvest_ready_share::text, ',' order by created_at) from public.forecast_basis_settings where from_week = 43);
  end if;
end $$;

-- ── Refused: after the week ended, full lifecycle, out of range ─────────────
do $$
begin
  begin
    perform public.revise_official_forecast('cccccccc-0000-4000-8000-0000000c0042', 0.8);
    raise exception 'revised after the deadline';
  exception when sqlstate '22023' then
    if sqlerrm not like 'The W42 2026 sampling week has ended%' then raise; end if;
  end;
  begin
    perform public.revise_official_forecast('cccccccc-0000-4000-8000-0000000c0041', 0.8);
    raise exception 'revised a lifecycle forecast';
  exception when sqlstate '22023' then null;
  end;
  begin
    perform public.revise_official_forecast('cccccccc-0000-4000-8000-0000000c0043', 1.2);
    raise exception 'accepted 120%%';
  exception when sqlstate '22023' then null;
  end;
  begin
    perform public.revise_official_forecast('cccccccc-0000-4000-8000-0000000c0043', 0.01);
    raise exception 'accepted 1%%';
  exception when sqlstate '22023' then null;
  end;
end $$;

-- ── Versions can't be edited or removed ─────────────────────────────────────
reset role;
do $$
begin
  begin
    update public.forecast_runs set harvest_ready_share = 0.9 where id = 'cccccccc-0000-4000-8000-0000000c0043';
    raise exception 'a locked version was updated';
  exception when sqlstate '42501' then null;
  end;
  begin
    delete from public.forecast_runs where id = 'cccccccc-0000-4000-8000-0000000c0043';
    raise exception 'a locked version was deleted';
  exception when sqlstate '42501' then null;
  end;
end $$;

-- ── Others can't revise ─────────────────────────────────────────────────────
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "cccccccc-0000-4000-8000-00000000c002", "role": "authenticated"}', true);
do $$
begin
  perform public.revise_official_forecast('cccccccc-0000-4000-8000-0000000c0043', 0.9);
  raise exception 'a non-member revised';
exception when sqlstate '42501' then null;
end $$;
reset role;
set local role anon;
do $$
begin
  perform public.revise_official_forecast('cccccccc-0000-4000-8000-0000000c0043', 0.9);
  raise exception 'anon revised';
exception when insufficient_privilege then null;
end $$;
reset role;

-- ── Locking an already-locked week returns its latest revision ──────────────
select set_config('request.jwt.claims', '{"role": "service_role"}', true);
do $$
declare r record;
begin
  select * into r from public.lock_forecast_run(gen_random_uuid(), 'cccccccc-0000-4000-8000-00000000cc01', 2026, 43, gen_random_uuid(), now(), 2, 1,
    'x', 'experimental', '{}', '{}', '{}', 0, '{}', 1, '{}', '[]', 'breaker_only', 0.7, '{}', 1);
  if r.stored_now or r.run_id <> (select id from public.forecast_runs where crop_id = 'cccccccc-0000-4000-8000-00000000cc01' and origin_week = 43 and revision = 3) then
    raise exception 'lock_forecast_run on a locked week: %', r;
  end if;
end $$;

-- ── The deadline across New Year, in greenhouse time ────────────────────────
do $$
begin
  -- 2026-W53 (Dec 28 – Jan 3) ends Monday 2027-01-04 00:00 Toronto (EST) = 05:00 UTC.
  if (to_date('2026-53', 'IYYY-IW') + 7)::timestamp at time zone 'America/Toronto' <> timestamptz '2027-01-04 05:00:00+00' then raise exception 'W53 deadline'; end if;
  -- 2027-W01 forecasts 2027-W02 (Monday 2027-01-11).
  if (to_date('2027-01', 'IYYY-IW') + 7)::timestamp at time zone 'America/Toronto' <> timestamptz '2027-01-11 05:00:00+00' then raise exception 'W01 deadline'; end if;
  -- W43 2026 (Oct 19–25) ends Monday 2026-10-26 00:00 EDT = 04:00 UTC.
  if (to_date('2026-43', 'IYYY-IW') + 7)::timestamp at time zone 'America/Toronto' <> timestamptz '2026-10-26 04:00:00+00' then raise exception 'W43 deadline'; end if;
end $$;

select '{"result": "official_forecast_revisions tests passed"}' as result;
rollback;
