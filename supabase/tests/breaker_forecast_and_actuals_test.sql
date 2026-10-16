-- 20261024000000_breaker_forecast_and_actuals: actual harvested kg and
-- forecast basis settings (append-only, stamped by the server, private per
-- organization), forecast_basis_at(), lifecycle-only flags left out of
-- Breakers-only weeks, the 'incomplete' lock rule, and storing a
-- Breakers-only forecast with its unavailable weeks.
--
-- Runs inside a transaction that is always rolled back.
--   npx supabase db query --linked -f supabase/tests/breaker_forecast_and_actuals_test.sql
-- Prints {"result": "breaker_forecast_and_actuals tests passed"} on success.

begin;

insert into auth.users (id, email, aud, role) values
  ('aaaaaaaa-0000-4000-8000-00000000d001', 'bfa-test-a@example.invalid', 'authenticated', 'authenticated'),
  ('bbbbbbbb-0000-4000-8000-00000000d001', 'bfa-test-b@example.invalid', 'authenticated', 'authenticated');
insert into public.organizations (id, name) values
  ('aaaaaaaa-0000-4000-8000-00000000d0a0', 'BFA Org A'),
  ('bbbbbbbb-0000-4000-8000-00000000d0b0', 'BFA Org B');
insert into public.organization_members (organization_id, user_id, role) values
  ('aaaaaaaa-0000-4000-8000-00000000d0a0', 'aaaaaaaa-0000-4000-8000-00000000d001', 'owner'),
  ('bbbbbbbb-0000-4000-8000-00000000d0b0', 'bbbbbbbb-0000-4000-8000-00000000d001', 'owner');
insert into public.crops (id, organization_id, name, color, planting_date, pullout_date, area_m2, picking_stems, case_weight_kg) values
  ('aaaaaaaa-0000-4000-8000-00000000dc01', 'aaaaaaaa-0000-4000-8000-00000000d0a0', 'Crop A', 'orange', '2025-12-01', '2027-12-01', 100, 700, 5);
insert into public.measurement_rows (id, organization_id, crop_id, row_name) values
  ('aaaaaaaa-0000-4000-8000-00000000d101', 'aaaaaaaa-0000-4000-8000-00000000d0a0', 'aaaaaaaa-0000-4000-8000-00000000dc01', 'Row A');
insert into public.measurement_stems (id, organization_id, crop_id, measurement_row_id, stem_name, created_at) values
  ('aaaaaaaa-0000-4000-8000-00000000d201', 'aaaaaaaa-0000-4000-8000-00000000d0a0', 'aaaaaaaa-0000-4000-8000-00000000dc01', 'aaaaaaaa-0000-4000-8000-00000000d101', 'S1', '2026-01-01'),
  ('aaaaaaaa-0000-4000-8000-00000000d202', 'aaaaaaaa-0000-4000-8000-00000000d0a0', 'aaaaaaaa-0000-4000-8000-00000000dc01', 'aaaaaaaa-0000-4000-8000-00000000d101', 'S2', '2026-01-01'),
  -- An active stem with no records at all is still in the sample: it must be checked too.
  ('aaaaaaaa-0000-4000-8000-00000000d203', 'aaaaaaaa-0000-4000-8000-00000000d0a0', 'aaaaaaaa-0000-4000-8000-00000000dc01', 'aaaaaaaa-0000-4000-8000-00000000d101', 'S3', '2026-01-01'),
  -- An inactive stem doesn't count.
  ('aaaaaaaa-0000-4000-8000-00000000d204', 'aaaaaaaa-0000-4000-8000-00000000d0a0', 'aaaaaaaa-0000-4000-8000-00000000dc01', 'aaaaaaaa-0000-4000-8000-00000000d101', 'S4', '2026-01-01');
update public.measurement_stems set is_active = false where id = 'aaaaaaaa-0000-4000-8000-00000000d204';
insert into public.plant_nodes (id, organization_id, crop_id, measurement_stem_id, node_number) values
  ('aaaaaaaa-0000-4000-8000-00000000d301', 'aaaaaaaa-0000-4000-8000-00000000d0a0', 'aaaaaaaa-0000-4000-8000-00000000dc01', 'aaaaaaaa-0000-4000-8000-00000000d201', 1),
  ('aaaaaaaa-0000-4000-8000-00000000d302', 'aaaaaaaa-0000-4000-8000-00000000d0a0', 'aaaaaaaa-0000-4000-8000-00000000dc01', 'aaaaaaaa-0000-4000-8000-00000000d202', 1),
  ('aaaaaaaa-0000-4000-8000-00000000d303', 'aaaaaaaa-0000-4000-8000-00000000d0a0', 'aaaaaaaa-0000-4000-8000-00000000dc01', 'aaaaaaaa-0000-4000-8000-00000000d201', 2);
-- d303: set in 2026-W10, harvested W22 (12 weeks: a long_development flag, a lifecycle-only rule).
insert into public.node_observations (organization_id, crop_id, plant_node_id, year, week_number, status, observed_at, recorded_at)
select 'aaaaaaaa-0000-4000-8000-00000000d0a0', 'aaaaaaaa-0000-4000-8000-00000000dc01', 'aaaaaaaa-0000-4000-8000-00000000d303', 2026, w, s,
       to_date('2026-' || lpad(w::text, 2, '0'), 'IYYY-IW') + time '12:00', to_date('2026-' || lpad(w::text, 2, '0'), 'IYYY-IW') + time '12:00'
from (values (10, 'SetFruit'), (22, 'Harvested')) v(w, s);

create temporary table cw on commit drop as
select extract(isoyear from now() at time zone 'America/Toronto')::integer as y,
       extract(week from now() at time zone 'America/Toronto')::integer as w;
grant select on cw to authenticated, service_role;

-- This week's walkthrough: a Breaker on each stem (both stems are in the sample).
insert into public.node_observations (organization_id, crop_id, plant_node_id, year, week_number, status, observed_at, recorded_at)
select 'aaaaaaaa-0000-4000-8000-00000000d0a0', 'aaaaaaaa-0000-4000-8000-00000000dc01', n::uuid, (select y from cw), (select w from cw), 'BreakerFruit', now(), now()
from unnest(array['aaaaaaaa-0000-4000-8000-00000000d301', 'aaaaaaaa-0000-4000-8000-00000000d302']) n;

-- A Breakers-only forecast's weeks: next week with numbers, weeks 2–8 not available.
create function pg_temp.breaker_weeks(oy integer, ow integer, unavailable_with_numbers boolean default false) returns jsonb language sql as $$
  select jsonb_agg(jsonb_build_object(
    'horizon', h,
    'target_year', extract(isoyear from to_date(oy || '-' || lpad(ow::text, 2, '0'), 'IYYY-IW') + 7 * h)::integer,
    'target_week', extract(week from to_date(oy || '-' || lpad(ow::text, 2, '0'), 'IYYY-IW') + 7 * h)::integer,
    'window', case when h <= 5 then 'marketing' else 'outlook' end,
    'available', h = 1)
    || case when h = 1 or unavailable_with_numbers then jsonb_build_object('sample_fruit', 1.7, 'sample_variance', 0.26, 'crop_fruit', 595,
         'components', jsonb_build_object('breaker', 1.7), 'expected_aborted', 0, 'expected_pruned', 0, 'afw_g', 180, 'afw_source', 'Grower AFW', 'afw_kind', 'grower', 'kg', 107.1)
       else '{}'::jsonb end
    order by h)
  from generate_series(1, 8) h
$$;
grant execute on function pg_temp.breaker_weeks(integer, integer, boolean) to authenticated, service_role;

create function pg_temp.lock_breaker(run uuid, ev uuid, weeks jsonb, share numeric default 0.85)
returns table (run_id uuid, kind text, stored_now boolean, locked_at timestamptz) language sql as $$
  select * from public.lock_forecast_run(run, 'aaaaaaaa-0000-4000-8000-00000000dc01', (select y from cw), (select w from cw), ev, now(), 8, 5,
    'engine-test', 'experimental', array['Experimental: next week = 85% of this week''s Breakers'], '{}'::jsonb, '{}'::jsonb, 2,
    array['aaaaaaaa-0000-4000-8000-00000000d201'::uuid, 'aaaaaaaa-0000-4000-8000-00000000d202'::uuid], 350,
    '{"sample_fruit": null, "crop_fruit": null, "kg": null}'::jsonb, weeks, 'breaker_only', share,
    '{"total": 2, "carriedOver": 0, "new": 0, "firstSeen": 2, "notRecordedAgain": 0, "possibleLaterCrop": 105}'::jsonb, 1)
$$;
grant execute on function pg_temp.lock_breaker(uuid, uuid, jsonb, numeric) to authenticated, service_role;

-- ── As a member of A ─────────────────────────────────────────────────────────
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-4000-8000-00000000d001","role":"authenticated"}', true);

do $$
declare r record;
begin
  -- Actual kg: who and when are the server's, whatever the client sends.
  insert into public.weekly_harvest_actuals (organization_id, crop_id, year, week, actual_kg, entered_by, entered_at)
  values ('aaaaaaaa-0000-4000-8000-00000000d0a0', 'aaaaaaaa-0000-4000-8000-00000000dc01', 2026, 43, 50000, 'bbbbbbbb-0000-4000-8000-00000000d001', '2020-01-01');
  select * into r from public.weekly_harvest_actuals where week = 43;
  if r.entered_by <> 'aaaaaaaa-0000-4000-8000-00000000d001' or r.entered_at < now() - interval '1 minute' then raise exception 'FAIL: entry not stamped %', r; end if;
  -- A correction and a clear are new rows: every entry is kept.
  insert into public.weekly_harvest_actuals (organization_id, crop_id, year, week, actual_kg, note)
  values ('aaaaaaaa-0000-4000-8000-00000000d0a0', 'aaaaaaaa-0000-4000-8000-00000000dc01', 2026, 43, 52500, 'packhouse total corrected'),
         ('aaaaaaaa-0000-4000-8000-00000000d0a0', 'aaaaaaaa-0000-4000-8000-00000000dc01', 2026, 44, null, null);
  if (select count(*) from public.weekly_harvest_actuals) <> 3 then raise exception 'FAIL: history kept'; end if;
  begin
    insert into public.weekly_harvest_actuals (organization_id, crop_id, year, week, actual_kg) values ('aaaaaaaa-0000-4000-8000-00000000d0a0', 'aaaaaaaa-0000-4000-8000-00000000dc01', 2026, 45, -1);
    raise exception 'FAIL: negative kg accepted';
  exception when check_violation then null;
  end;
  begin
    insert into public.weekly_harvest_actuals (organization_id, crop_id, year, week, actual_kg) values ('aaaaaaaa-0000-4000-8000-00000000d0a0', 'aaaaaaaa-0000-4000-8000-00000000dc01', 2026, 54, 1);
    raise exception 'FAIL: week 54 accepted';
  exception when check_violation then null;
  end;

  -- Basis settings: Mathieu-style, lifecycle then Breakers only from W42.
  insert into public.forecast_basis_settings (organization_id, crop_id, from_year, from_week, basis, harvest_ready_share)
  values ('aaaaaaaa-0000-4000-8000-00000000d0a0', 'aaaaaaaa-0000-4000-8000-00000000dc01', 2026, 1, 'lifecycle', null),
         ('aaaaaaaa-0000-4000-8000-00000000d0a0', 'aaaaaaaa-0000-4000-8000-00000000dc01', 2026, 42, 'breaker_only', 0.85);
  begin
    insert into public.forecast_basis_settings (organization_id, crop_id, from_year, from_week, basis) values ('aaaaaaaa-0000-4000-8000-00000000d0a0', 'aaaaaaaa-0000-4000-8000-00000000dc01', 2026, 43, 'breaker_only');
    raise exception 'FAIL: Breakers only without a share';
  exception when check_violation then null;
  end;
  begin
    insert into public.forecast_basis_settings (organization_id, crop_id, from_year, from_week, basis, harvest_ready_share) values ('aaaaaaaa-0000-4000-8000-00000000d0a0', 'aaaaaaaa-0000-4000-8000-00000000dc01', 2026, 43, 'lifecycle', 0.85);
    raise exception 'FAIL: lifecycle with a share';
  exception when check_violation then null;
  end;
  begin
    insert into public.forecast_basis_settings (organization_id, crop_id, from_year, from_week, basis, harvest_ready_share) values ('aaaaaaaa-0000-4000-8000-00000000d0a0', 'aaaaaaaa-0000-4000-8000-00000000dc01', 2026, 43, 'breaker_only', 1.5);
    raise exception 'FAIL: share above 100%%';
  exception when check_violation then null;
  end;
  if (select basis from public.forecast_basis_at('aaaaaaaa-0000-4000-8000-00000000dc01', 202641)) <> 'lifecycle' then raise exception 'FAIL: W41 lifecycle'; end if;
  select * into r from public.forecast_basis_at('aaaaaaaa-0000-4000-8000-00000000dc01', 202650);
  if r.basis <> 'breaker_only' or r.harvest_ready_share <> 0.85 or r.from_week <> 42 then raise exception 'FAIL: W50 %', r; end if;
  if exists (select 1 from public.forecast_basis_at('aaaaaaaa-0000-4000-8000-00000000dc01', 202552)) then raise exception 'FAIL: a setting before any start week'; end if;
end $$;

-- Append-only.
do $$
begin
  update public.weekly_harvest_actuals set actual_kg = 1;
  raise exception 'FAIL: actuals can be changed';
exception when insufficient_privilege then null;
end $$;
do $$
begin
  delete from public.forecast_basis_settings;
  raise exception 'FAIL: settings can be deleted';
exception when insufficient_privilege then null;
end $$;

-- Lifecycle-only flags are left out of Breakers-only weeks (crop_quality_flags_all keeps them).
do $$
begin
  if not exists (select 1 from public.crop_quality_flags('aaaaaaaa-0000-4000-8000-00000000dc01') where rule_id = 'long_development') then
    raise exception 'FAIL: long_development hidden in a lifecycle week';
  end if;
end $$;
reset role;
insert into public.forecast_basis_settings (organization_id, crop_id, from_year, from_week, basis, harvest_ready_share)
values ('aaaaaaaa-0000-4000-8000-00000000d0a0', 'aaaaaaaa-0000-4000-8000-00000000dc01', 2026, 20, 'breaker_only', 0.85);
set local role authenticated;
do $$
begin
  if exists (select 1 from public.crop_quality_flags('aaaaaaaa-0000-4000-8000-00000000dc01') where rule_id = 'long_development') then
    raise exception 'FAIL: long_development shown in a Breakers-only week';
  end if;
  if not exists (select 1 from public.crop_quality_flags_all('aaaaaaaa-0000-4000-8000-00000000dc01') where rule_id = 'long_development') then
    raise exception 'FAIL: crop_quality_flags_all lost the flag';
  end if;
end $$;

-- ── The Friday walkthrough: an official forecast needs every sampled stem checked ──
do $$
declare r record;
begin
  -- Only S1 checked when sampling is marked complete (a few minutes ago).
  insert into public.stem_visits (organization_id, crop_id, measurement_stem_id, year, week_number, checked, observed_at)
  values ('aaaaaaaa-0000-4000-8000-00000000d0a0', 'aaaaaaaa-0000-4000-8000-00000000dc01', 'aaaaaaaa-0000-4000-8000-00000000d201', (select y from cw), (select w from cw), true, now() - interval '3 minutes');
  insert into public.sampling_week_events (id, organization_id, crop_id, year, week_number, event, stems_checked_seen, stems_expected_seen, observed_at, recorded_at)
  values ('aaaaaaaa-0000-4000-8000-00000000d501', 'aaaaaaaa-0000-4000-8000-00000000d0a0', 'aaaaaaaa-0000-4000-8000-00000000dc01', (select y from cw), (select w from cw), 'completed', 1, 2,
          now() - interval '2 minutes', now() - interval '2 minutes');
  select * into r from public.forecast_lock_readiness('aaaaaaaa-0000-4000-8000-00000000d501');
  if r.state <> 'incomplete' or r.detail not like '1 of the 3 sampled stems were checked%' then raise exception 'FAIL: readiness %', r; end if;
  begin
    perform pg_temp.lock_breaker('aaaaaaaa-0000-4000-8000-00000000df01', 'aaaaaaaa-0000-4000-8000-00000000d501', pg_temp.breaker_weeks((select y from cw), (select w from cw)));
    raise exception 'FAIL: locked an incomplete walkthrough';
  exception when invalid_parameter_value then null;
  end;
  -- S2 checked after completion: still incomplete (later checks don't count for that completion).
  insert into public.stem_visits (organization_id, crop_id, measurement_stem_id, year, week_number, checked, observed_at)
  values ('aaaaaaaa-0000-4000-8000-00000000d0a0', 'aaaaaaaa-0000-4000-8000-00000000dc01', 'aaaaaaaa-0000-4000-8000-00000000d202', (select y from cw), (select w from cw), true, now() - interval '1 minute'),
         ('aaaaaaaa-0000-4000-8000-00000000d0a0', 'aaaaaaaa-0000-4000-8000-00000000dc01', 'aaaaaaaa-0000-4000-8000-00000000d203', (select y from cw), (select w from cw), true, now() - interval '1 minute');
  if (select state from public.forecast_lock_readiness('aaaaaaaa-0000-4000-8000-00000000d501')) <> 'incomplete' then raise exception 'FAIL: a late check counted'; end if;
end $$;

-- The worker marks that job incomplete (final) and claims nothing.
reset role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
set local role service_role;
do $$
declare r record;
begin
  if exists (select 1 from public.claim_forecast_lock_job()) then raise exception 'FAIL: claimed an incomplete walkthrough'; end if;
  select * into r from public.forecast_lock_jobs where sampling_event_id = 'aaaaaaaa-0000-4000-8000-00000000d501';
  if r.status <> 'incomplete' then raise exception 'FAIL: job %', r; end if;
end $$;

-- Completed again with every active stem checked: ready, and a Breakers-only forecast is stored.
reset role;
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-4000-8000-00000000d001","role":"authenticated"}', true);
set local role authenticated;
do $$
declare r record;
begin
  insert into public.sampling_week_events (id, organization_id, crop_id, year, week_number, event, stems_checked_seen, stems_expected_seen, observed_at, recorded_at)
  values ('aaaaaaaa-0000-4000-8000-00000000d502', 'aaaaaaaa-0000-4000-8000-00000000d0a0', 'aaaaaaaa-0000-4000-8000-00000000dc01', (select y from cw), (select w from cw),
          'completed', 3, 3, now(), now());
  select * into r from public.forecast_lock_readiness('aaaaaaaa-0000-4000-8000-00000000d502');
  if r.state <> 'ready' then raise exception 'FAIL: readiness after all stems checked %', r; end if;
  -- A week marked unavailable may not carry numbers; Breakers only needs a share.
  begin
    perform pg_temp.lock_breaker('aaaaaaaa-0000-4000-8000-00000000df01', 'aaaaaaaa-0000-4000-8000-00000000d502', pg_temp.breaker_weeks((select y from cw), (select w from cw), true));
    raise exception 'FAIL: an unavailable week with numbers';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform pg_temp.lock_breaker('aaaaaaaa-0000-4000-8000-00000000df01', 'aaaaaaaa-0000-4000-8000-00000000d502', pg_temp.breaker_weeks((select y from cw), (select w from cw)), null);
    raise exception 'FAIL: Breakers only without a share';
  exception when invalid_parameter_value then null;
  end;
end $$;

do $$
declare r record;
begin
  select * into r from pg_temp.lock_breaker('aaaaaaaa-0000-4000-8000-00000000df01', 'aaaaaaaa-0000-4000-8000-00000000d502', pg_temp.breaker_weeks((select y from cw), (select w from cw)));
  if not r.stored_now then raise exception 'FAIL: Breakers-only forecast not stored %', r; end if;
  select * into r from public.forecast_runs where id = 'aaaaaaaa-0000-4000-8000-00000000df01';
  if r.basis <> 'breaker_only' or r.harvest_ready_share <> 0.85 or r.coverage <> 1 or (r.breaker_breakdown ->> 'firstSeen')::integer <> 2
     or r.marketing_kg is not null or r.marketing_crop_fruit is not null then
    raise exception 'FAIL: stored run %', r;
  end if;
  if (select count(*) from public.forecast_run_weeks where run_id = 'aaaaaaaa-0000-4000-8000-00000000df01' and available) <> 1
     or exists (select 1 from public.forecast_run_weeks where run_id = 'aaaaaaaa-0000-4000-8000-00000000df01' and not available and (kg is not null or crop_fruit is not null or cases is not null)) then
    raise exception 'FAIL: unavailable weeks stored with numbers';
  end if;
  if (select cases from public.forecast_run_weeks where run_id = 'aaaaaaaa-0000-4000-8000-00000000df01' and horizon = 1) <> 107.1 / 5 then raise exception 'FAIL: next week cases'; end if;
end $$;

-- ── Another organization sees and adds nothing ──────────────────────────────
select set_config('request.jwt.claims', '{"sub":"bbbbbbbb-0000-4000-8000-00000000d001","role":"authenticated"}', true);
do $$
begin
  if exists (select 1 from public.weekly_harvest_actuals) or exists (select 1 from public.forecast_basis_settings) then raise exception 'FAIL: B sees A''s entries'; end if;
  insert into public.weekly_harvest_actuals (organization_id, crop_id, year, week, actual_kg) values ('aaaaaaaa-0000-4000-8000-00000000d0a0', 'aaaaaaaa-0000-4000-8000-00000000dc01', 2026, 46, 1);
  raise exception 'FAIL: B entered A''s actual kg';
exception when insufficient_privilege then null;
end $$;
do $$
begin
  insert into public.forecast_basis_settings (organization_id, crop_id, from_year, from_week, basis) values ('aaaaaaaa-0000-4000-8000-00000000d0a0', 'aaaaaaaa-0000-4000-8000-00000000dc01', 2026, 46, 'lifecycle');
  raise exception 'FAIL: B changed A''s forecast settings';
exception when insufficient_privilege then null;
end $$;

-- anon: nothing.
reset role;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
set local role anon;
do $$
begin
  perform 1 from public.weekly_harvest_actuals;
  raise exception 'FAIL: anon can read actuals';
exception when insufficient_privilege then null;
end $$;

reset role;
select 'breaker_forecast_and_actuals tests passed' as result;
rollback;
