-- Collector schema checks: RLS isolation, cross-org integrity, idempotent
-- inserts, append-only observations, week validation.
--
-- Runs inside a transaction that is always rolled back, so it leaves nothing
-- behind. Any failed expectation raises and aborts the script.
--
--   npx supabase db query --linked -f supabase/tests/collector_rls_test.sql
--
-- Prints a single row {"result": "collector RLS tests passed"} on success.

begin;

-- Fixture: two organizations, each with one member and one crop.
insert into auth.users (id, email, aud, role) values
  ('aaaaaaaa-0000-4000-8000-000000000001', 'collector-test-a@example.invalid', 'authenticated', 'authenticated'),
  ('bbbbbbbb-0000-4000-8000-000000000001', 'collector-test-b@example.invalid', 'authenticated', 'authenticated');
insert into public.organizations (id, name) values
  ('aaaaaaaa-0000-4000-8000-0000000000a0', 'Test Org A'),
  ('bbbbbbbb-0000-4000-8000-0000000000b0', 'Test Org B');
insert into public.organization_members (organization_id, user_id, role) values
  ('aaaaaaaa-0000-4000-8000-0000000000a0', 'aaaaaaaa-0000-4000-8000-000000000001', 'owner'),
  ('bbbbbbbb-0000-4000-8000-0000000000b0', 'bbbbbbbb-0000-4000-8000-000000000001', 'owner');
insert into public.crops (id, organization_id, name, color, planting_date, pullout_date, area_m2, picking_stems, created_by) values
  ('aaaaaaaa-0000-4000-8000-00000000c001', 'aaaaaaaa-0000-4000-8000-0000000000a0', 'Crop A', 'red', '2026-01-01', '2026-12-01', 100, 100, null),
  ('bbbbbbbb-0000-4000-8000-00000000c001', 'bbbbbbbb-0000-4000-8000-0000000000b0', 'Crop B', 'red', '2026-01-01', '2026-12-01', 100, 100, null);

-- ---------------------------------------------------------------- user A
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-4000-8000-000000000001","role":"authenticated"}', true);

insert into public.measurement_rows (id, organization_id, crop_id, row_name, sort_order) values
  ('aaaaaaaa-0000-4000-8000-0000000001a1', 'aaaaaaaa-0000-4000-8000-0000000000a0', 'aaaaaaaa-0000-4000-8000-00000000c001', 'Row 1', 1)
  on conflict (id) do nothing;
-- Replaying the same insert (lost response, retry) must not duplicate.
insert into public.measurement_rows (id, organization_id, crop_id, row_name, sort_order) values
  ('aaaaaaaa-0000-4000-8000-0000000001a1', 'aaaaaaaa-0000-4000-8000-0000000000a0', 'aaaaaaaa-0000-4000-8000-00000000c001', 'Row 1', 1)
  on conflict (id) do nothing;
insert into public.measurement_stems (id, organization_id, crop_id, measurement_row_id, stem_name, sort_order) values
  ('aaaaaaaa-0000-4000-8000-0000000002a1', 'aaaaaaaa-0000-4000-8000-0000000000a0', 'aaaaaaaa-0000-4000-8000-00000000c001', 'aaaaaaaa-0000-4000-8000-0000000001a1', 'Stem 1', 1);
insert into public.plant_nodes (id, organization_id, crop_id, measurement_stem_id, node_number, sort_order) values
  ('aaaaaaaa-0000-4000-8000-0000000003a1', 'aaaaaaaa-0000-4000-8000-0000000000a0', 'aaaaaaaa-0000-4000-8000-00000000c001', 'aaaaaaaa-0000-4000-8000-0000000002a1', 1, 1);
insert into public.plant_nodes (id, organization_id, crop_id, measurement_stem_id, node_number, sort_order, is_side_shoot, parent_node_id, node_label, side) values
  ('aaaaaaaa-0000-4000-8000-0000000003a2', 'aaaaaaaa-0000-4000-8000-0000000000a0', 'aaaaaaaa-0000-4000-8000-00000000c001', 'aaaaaaaa-0000-4000-8000-0000000002a1', 1, 1, true, 'aaaaaaaa-0000-4000-8000-0000000003a1', '1+1', 'right');
insert into public.node_observations (id, organization_id, crop_id, plant_node_id, year, week_number, status, observed_at) values
  ('aaaaaaaa-0000-4000-8000-0000000004a1', 'aaaaaaaa-0000-4000-8000-0000000000a0', 'aaaaaaaa-0000-4000-8000-00000000c001', 'aaaaaaaa-0000-4000-8000-0000000003a1', 2026, 40, 'Flower', '2026-10-01T12:00:00Z'),
  ('aaaaaaaa-0000-4000-8000-0000000004a2', 'aaaaaaaa-0000-4000-8000-0000000000a0', 'aaaaaaaa-0000-4000-8000-00000000c001', 'aaaaaaaa-0000-4000-8000-0000000003a1', 2026, 41, 'SetFruit', '2026-10-06T12:00:00Z'),
  -- 2026 has 53 ISO weeks.
  ('aaaaaaaa-0000-4000-8000-0000000004a3', 'aaaaaaaa-0000-4000-8000-0000000000a0', 'aaaaaaaa-0000-4000-8000-00000000c001', 'aaaaaaaa-0000-4000-8000-0000000003a2', 2026, 53, 'Pruned', '2026-12-30T12:00:00Z');
insert into public.node_observations (id, organization_id, crop_id, plant_node_id, year, week_number, status, observed_at) values
  ('aaaaaaaa-0000-4000-8000-0000000004a2', 'aaaaaaaa-0000-4000-8000-0000000000a0', 'aaaaaaaa-0000-4000-8000-00000000c001', 'aaaaaaaa-0000-4000-8000-0000000003a1', 2026, 41, 'SetFruit', '2026-10-06T12:00:00Z')
  on conflict (id) do nothing;
insert into public.stem_growth_measurements (id, organization_id, crop_id, measurement_stem_id, year, week_number, growth_cm, top_node_number, observed_at) values
  ('aaaaaaaa-0000-4000-8000-0000000005a1', 'aaaaaaaa-0000-4000-8000-0000000000a0', 'aaaaaaaa-0000-4000-8000-00000000c001', 'aaaaaaaa-0000-4000-8000-0000000002a1', 2026, 41, 8.5, 1, now());
-- Correcting the same week's reading updates it in place.
insert into public.stem_growth_measurements (id, organization_id, crop_id, measurement_stem_id, year, week_number, growth_cm, top_node_number, observed_at) values
  ('aaaaaaaa-0000-4000-8000-0000000005a1', 'aaaaaaaa-0000-4000-8000-0000000000a0', 'aaaaaaaa-0000-4000-8000-00000000c001', 'aaaaaaaa-0000-4000-8000-0000000002a1', 2026, 41, 9.0, 1, now())
  on conflict (measurement_stem_id, year, week_number) do update set growth_cm = excluded.growth_cm;

do $$
declare n int; s text;
begin
  select count(*) into n from public.measurement_rows;
  if n <> 1 then raise exception 'A should see exactly 1 row, saw %', n; end if;
  select count(*) into n from public.node_observations;
  if n <> 3 then raise exception 'retried observation duplicated: % rows', n; end if;
  select status into s from public.node_latest_statuses where plant_node_id = 'aaaaaaaa-0000-4000-8000-0000000003a1';
  if s is distinct from 'SetFruit' then raise exception 'latest status should be SetFruit, got %', s; end if;
  select count(*) into n from public.node_latest_statuses where measurement_row_id = 'aaaaaaaa-0000-4000-8000-0000000001a1';
  if n <> 2 then raise exception 'latest statuses by row should be 2, got %', n; end if;
  select growth_cm into s from public.stem_growth_measurements;
  if s::numeric <> 9.0 then raise exception 'growth correction not applied: %', s; end if;
  if (select created_by from public.measurement_rows) <> 'aaaaaaaa-0000-4000-8000-000000000001' then
    raise exception 'created_by not stamped';
  end if;

  -- Cannot write into another organization.
  begin
    insert into public.measurement_rows (organization_id, crop_id, row_name) values
      ('bbbbbbbb-0000-4000-8000-0000000000b0', 'bbbbbbbb-0000-4000-8000-00000000c001', 'Intruder');
    raise exception 'FAIL: inserted a row into another organization';
  exception when insufficient_privilege then null;
  end;
  -- Cannot attach own-org row to another org's crop.
  begin
    insert into public.measurement_rows (organization_id, crop_id, row_name) values
      ('aaaaaaaa-0000-4000-8000-0000000000a0', 'bbbbbbbb-0000-4000-8000-00000000c001', 'Wrong crop');
    raise exception 'FAIL: row referenced another organization''s crop';
  exception when foreign_key_violation then null;
  end;
  -- Child crop_id must match its parent's.
  begin
    insert into public.measurement_stems (organization_id, crop_id, measurement_row_id, stem_name) values
      ('aaaaaaaa-0000-4000-8000-0000000000a0', 'bbbbbbbb-0000-4000-8000-00000000c001', 'aaaaaaaa-0000-4000-8000-0000000001a1', 'Bad');
    raise exception 'FAIL: stem crop_id differs from its row';
  exception when foreign_key_violation then null;
  end;
  -- Unknown status.
  begin
    insert into public.node_observations (organization_id, crop_id, plant_node_id, year, week_number, status, observed_at) values
      ('aaaaaaaa-0000-4000-8000-0000000000a0', 'aaaaaaaa-0000-4000-8000-00000000c001', 'aaaaaaaa-0000-4000-8000-0000000003a1', 2026, 41, 'GolfBall', now());
    raise exception 'FAIL: accepted an unknown status';
  exception when check_violation then null;
  end;
  -- 2027 has only 52 ISO weeks.
  begin
    insert into public.node_observations (organization_id, crop_id, plant_node_id, year, week_number, status, observed_at) values
      ('aaaaaaaa-0000-4000-8000-0000000000a0', 'aaaaaaaa-0000-4000-8000-00000000c001', 'aaaaaaaa-0000-4000-8000-0000000003a1', 2027, 53, 'Flower', now());
    raise exception 'FAIL: accepted 2027-W53';
  exception when check_violation then null;
  end;
  -- Side shoot needs a parent on the same stem.
  begin
    insert into public.plant_nodes (organization_id, crop_id, measurement_stem_id, node_number, is_side_shoot, side) values
      ('aaaaaaaa-0000-4000-8000-0000000000a0', 'aaaaaaaa-0000-4000-8000-00000000c001', 'aaaaaaaa-0000-4000-8000-0000000002a1', 2, true, 'left');
    raise exception 'FAIL: side shoot without parent';
  exception when check_violation then null;
  end;
  -- Observations are append-only.
  begin
    update public.node_observations set status = 'Harvested';
    raise exception 'FAIL: observations are updatable';
  exception when insufficient_privilege then null;
  end;
  begin
    delete from public.node_observations;
    raise exception 'FAIL: observations are deletable';
  exception when insufficient_privilege then null;
  end;
  -- A crop with collector data can't be deleted.
  begin
    delete from public.crops where id = 'aaaaaaaa-0000-4000-8000-00000000c001';
    raise exception 'FAIL: deleted a crop that has collector data';
  exception when foreign_key_violation then null;
  end;
end $$;

-- ---------------------------------------------------------------- user B
select set_config('request.jwt.claims', '{"sub":"bbbbbbbb-0000-4000-8000-000000000001","role":"authenticated"}', true);

do $$
declare n int;
begin
  select (select count(*) from public.measurement_rows) + (select count(*) from public.measurement_stems)
       + (select count(*) from public.plant_nodes) + (select count(*) from public.node_observations)
       + (select count(*) from public.stem_growth_measurements) + (select count(*) from public.node_latest_statuses)
    into n;
  if n <> 0 then raise exception 'FAIL: B can see % of A''s collector records', n; end if;

  update public.plant_nodes set is_active = false;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL: B updated % of A''s nodes', n; end if;

  -- B claiming its own org but A's row: composite FK rejects it.
  begin
    insert into public.measurement_stems (organization_id, crop_id, measurement_row_id, stem_name) values
      ('bbbbbbbb-0000-4000-8000-0000000000b0', 'aaaaaaaa-0000-4000-8000-00000000c001', 'aaaaaaaa-0000-4000-8000-0000000001a1', 'Sneaky');
    raise exception 'FAIL: B attached a stem to A''s row';
  exception when foreign_key_violation then null;
  end;
  -- B claiming A's org: RLS rejects it.
  begin
    insert into public.measurement_stems (organization_id, crop_id, measurement_row_id, stem_name) values
      ('aaaaaaaa-0000-4000-8000-0000000000a0', 'aaaaaaaa-0000-4000-8000-00000000c001', 'aaaaaaaa-0000-4000-8000-0000000001a1', 'Sneaky');
    raise exception 'FAIL: B wrote into A''s organization';
  exception when insufficient_privilege then null;
  end;
end $$;

-- ---------------------------------------------------------------- anon
select set_config('request.jwt.claims', '{"role":"anon"}', true);
set local role anon;
do $$
begin
  perform count(*) from public.measurement_rows;
  raise exception 'FAIL: anon can read measurement_rows';
exception when insufficient_privilege then null;
end $$;

reset role;
select 'collector RLS tests passed' as result;
rollback;
