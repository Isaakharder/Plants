-- 20261025000000_forecast_previews: saved preliminary forecasts (append-only,
-- private per organization, separate from locked forecasts) and
-- forecast_input_signature() (changes when the week's data does, not when a
-- later week's does).
--
-- Runs inside a transaction that is always rolled back.
--   npx supabase db query --linked -f supabase/tests/forecast_previews_test.sql
-- Prints {"result": "forecast_previews tests passed"} on success.

begin;

insert into auth.users (id, email, aud, role) values
  ('aaaaaaaa-0000-4000-8000-00000000a501', 'fp-test-a@example.invalid', 'authenticated', 'authenticated'),
  ('bbbbbbbb-0000-4000-8000-00000000a501', 'fp-test-b@example.invalid', 'authenticated', 'authenticated');
insert into public.organizations (id, name) values
  ('aaaaaaaa-0000-4000-8000-00000000a5a0', 'FP Org A'),
  ('bbbbbbbb-0000-4000-8000-00000000a5b0', 'FP Org B');
insert into public.organization_members (organization_id, user_id, role) values
  ('aaaaaaaa-0000-4000-8000-00000000a5a0', 'aaaaaaaa-0000-4000-8000-00000000a501', 'owner'),
  ('bbbbbbbb-0000-4000-8000-00000000a5b0', 'bbbbbbbb-0000-4000-8000-00000000a501', 'owner');
insert into public.crops (id, organization_id, name, color, planting_date, pullout_date, area_m2, picking_stems) values
  ('aaaaaaaa-0000-4000-8000-00000000a5c1', 'aaaaaaaa-0000-4000-8000-00000000a5a0', 'Crop A', 'red', '2025-12-01', '2027-12-01', 100, 700);
insert into public.measurement_rows (id, organization_id, crop_id, row_name) values
  ('aaaaaaaa-0000-4000-8000-00000000a511', 'aaaaaaaa-0000-4000-8000-00000000a5a0', 'aaaaaaaa-0000-4000-8000-00000000a5c1', 'Row A');
insert into public.measurement_stems (id, organization_id, crop_id, measurement_row_id, stem_name) values
  ('aaaaaaaa-0000-4000-8000-00000000a521', 'aaaaaaaa-0000-4000-8000-00000000a5a0', 'aaaaaaaa-0000-4000-8000-00000000a5c1', 'aaaaaaaa-0000-4000-8000-00000000a511', 'S1');
insert into public.plant_nodes (id, organization_id, crop_id, measurement_stem_id, node_number, created_at) values
  ('aaaaaaaa-0000-4000-8000-00000000a531', 'aaaaaaaa-0000-4000-8000-00000000a5a0', 'aaaaaaaa-0000-4000-8000-00000000a5c1', 'aaaaaaaa-0000-4000-8000-00000000a521', 1, '2026-10-01'),
  ('aaaaaaaa-0000-4000-8000-00000000a532', 'aaaaaaaa-0000-4000-8000-00000000a5a0', 'aaaaaaaa-0000-4000-8000-00000000a5c1', 'aaaaaaaa-0000-4000-8000-00000000a521', 2, '2026-10-01');
insert into public.node_observations (organization_id, crop_id, plant_node_id, year, week_number, status, observed_at, recorded_at) values
  ('aaaaaaaa-0000-4000-8000-00000000a5a0', 'aaaaaaaa-0000-4000-8000-00000000a5c1', 'aaaaaaaa-0000-4000-8000-00000000a531', 2026, 42, 'BreakerFruit', '2026-10-16 16:00Z', '2026-10-16 16:00Z');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-4000-8000-00000000a501","role":"authenticated"}', true);

do $$
declare
  s42 text := public.forecast_input_signature('aaaaaaaa-0000-4000-8000-00000000a5c1', 2026, 42);
  r record;
begin
  if s42 is null or length(s42) <> 32 then raise exception 'FAIL: signature %', s42; end if;
  if public.forecast_input_signature('aaaaaaaa-0000-4000-8000-00000000a5c1', 2026, 42) <> s42 then raise exception 'FAIL: signature not stable'; end if;

  -- Saved with who and when set by the server; the newest per week is the one shown.
  insert into public.forecast_previews (organization_id, crop_id, origin_year, origin_week, basis, engine_version, input_signature, preview, created_by, created_at)
  values ('aaaaaaaa-0000-4000-8000-00000000a5a0', 'aaaaaaaa-0000-4000-8000-00000000a5c1', 2026, 42, 'breaker_only', 'engine-test', s42, '{"result": {"weeks": []}}',
          'bbbbbbbb-0000-4000-8000-00000000a501', '2020-01-01');
  select * into r from public.forecast_previews;
  if r.created_by <> 'aaaaaaaa-0000-4000-8000-00000000a501' or r.created_at < now() - interval '1 minute' then raise exception 'FAIL: not stamped %', r; end if;
  begin
    insert into public.forecast_previews (organization_id, crop_id, origin_year, origin_week, basis, engine_version, input_signature, preview)
    values ('aaaaaaaa-0000-4000-8000-00000000a5a0', 'aaaaaaaa-0000-4000-8000-00000000a5c1', 2026, 42, 'official', 'engine-test', s42, '{}');
    raise exception 'FAIL: an unknown basis';
  exception when check_violation then null;
  end;
  -- Nothing official is touched.
  if exists (select 1 from public.forecast_runs) then raise exception 'FAIL: a preview created a locked forecast'; end if;
end $$;

-- A later week's records don't change W42's signature; a W42 record, a stem check or an AFW change does.
reset role;
do $$
declare
  s42 text := public.forecast_input_signature('aaaaaaaa-0000-4000-8000-00000000a5c1', 2026, 42);
  s text;
begin
  insert into public.node_observations (organization_id, crop_id, plant_node_id, year, week_number, status, observed_at, recorded_at)
  values ('aaaaaaaa-0000-4000-8000-00000000a5a0', 'aaaaaaaa-0000-4000-8000-00000000a5c1', 'aaaaaaaa-0000-4000-8000-00000000a532', 2026, 43, 'BreakerFruit', '2026-10-23 16:00Z', '2026-10-23 16:00Z');
  if public.forecast_input_signature('aaaaaaaa-0000-4000-8000-00000000a5c1', 2026, 42) <> s42 then raise exception 'FAIL: a W43 record changed W42''s signature'; end if;

  insert into public.node_observations (organization_id, crop_id, plant_node_id, year, week_number, status, observed_at, recorded_at)
  values ('aaaaaaaa-0000-4000-8000-00000000a5a0', 'aaaaaaaa-0000-4000-8000-00000000a5c1', 'aaaaaaaa-0000-4000-8000-00000000a532', 2026, 42, 'BreakerFruit', '2026-10-16 17:00Z', '2026-10-16 17:00Z');
  s := public.forecast_input_signature('aaaaaaaa-0000-4000-8000-00000000a5c1', 2026, 42);
  if s = s42 then raise exception 'FAIL: a W42 record left the signature unchanged'; end if;

  insert into public.stem_visits (organization_id, crop_id, measurement_stem_id, year, week_number, checked, observed_at, recorded_at)
  values ('aaaaaaaa-0000-4000-8000-00000000a5a0', 'aaaaaaaa-0000-4000-8000-00000000a5c1', 'aaaaaaaa-0000-4000-8000-00000000a521', 2026, 42, true, '2026-10-16 17:05Z', '2026-10-16 17:05Z');
  if public.forecast_input_signature('aaaaaaaa-0000-4000-8000-00000000a5c1', 2026, 42) = s then raise exception 'FAIL: a stem check left the signature unchanged'; end if;
  s := public.forecast_input_signature('aaaaaaaa-0000-4000-8000-00000000a5c1', 2026, 42);

  insert into public.weekly_harvest_afw (organization_id, crop_id, year, week, afw_g) values ('aaaaaaaa-0000-4000-8000-00000000a5a0', 'aaaaaaaa-0000-4000-8000-00000000a5c1', 2026, 43, 180);
  if public.forecast_input_signature('aaaaaaaa-0000-4000-8000-00000000a5c1', 2026, 42) = s then raise exception 'FAIL: an AFW entry left the signature unchanged'; end if;
end $$;

-- Append-only; private.
set local role authenticated;
do $$
begin
  update public.forecast_previews set basis = 'lifecycle';
  raise exception 'FAIL: a saved preview can be changed';
exception when insufficient_privilege then null;
end $$;
select set_config('request.jwt.claims', '{"sub":"bbbbbbbb-0000-4000-8000-00000000a501","role":"authenticated"}', true);
do $$
begin
  if exists (select 1 from public.forecast_previews) then raise exception 'FAIL: B sees A''s previews'; end if;
  insert into public.forecast_previews (organization_id, crop_id, origin_year, origin_week, basis, engine_version, input_signature, preview)
  values ('aaaaaaaa-0000-4000-8000-00000000a5a0', 'aaaaaaaa-0000-4000-8000-00000000a5c1', 2026, 42, 'breaker_only', 'x', 'x', '{}');
  raise exception 'FAIL: B saved a preview for A';
exception when insufficient_privilege then null;
end $$;

reset role;
select 'forecast_previews tests passed' as result;
rollback;
