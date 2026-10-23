-- lock_forecast_run(), forecast_runs / forecast_run_weeks immutability, the
-- AFW change log, crops.case_weight_kg and the long_development flag.
--
-- Runs inside a transaction that is always rolled back.
-- Prints {"result": "harvest_forecast_snapshots tests passed"} on success.

begin;

-- ── Fixture ──────────────────────────────────────────────────────────────────
insert into auth.users (id, email, aud, role) values
  ('aaaaaaaa-0000-4000-8000-00000000e001', 'hfs-test-a@example.invalid', 'authenticated', 'authenticated'),
  ('bbbbbbbb-0000-4000-8000-00000000e001', 'hfs-test-b@example.invalid', 'authenticated', 'authenticated');
insert into public.organizations (id, name) values
  ('aaaaaaaa-0000-4000-8000-00000000e0a0', 'HFS Org A'),
  ('bbbbbbbb-0000-4000-8000-00000000e0b0', 'HFS Org B');
insert into public.organization_members (organization_id, user_id, role) values
  ('aaaaaaaa-0000-4000-8000-00000000e0a0', 'aaaaaaaa-0000-4000-8000-00000000e001', 'owner'),
  ('bbbbbbbb-0000-4000-8000-00000000e0b0', 'bbbbbbbb-0000-4000-8000-00000000e001', 'owner');
insert into public.crops (id, organization_id, name, color, planting_date, pullout_date, area_m2, picking_stems, case_weight_kg, pepper_type_id) values
  ('aaaaaaaa-0000-4000-8000-00000000ec01', 'aaaaaaaa-0000-4000-8000-00000000e0a0', 'Crop A', 'red', '2025-12-01', '2027-12-01', 100, 700, 5, (select t.id from public.pepper_types t where t.organization_id = 'aaaaaaaa-0000-4000-8000-00000000e0a0' and t.key = 'bell'));
insert into public.measurement_rows (id, organization_id, crop_id, row_name) values
  ('aaaaaaaa-0000-4000-8000-00000000e101', 'aaaaaaaa-0000-4000-8000-00000000e0a0', 'aaaaaaaa-0000-4000-8000-00000000ec01', 'Row A');
insert into public.measurement_stems (id, organization_id, crop_id, measurement_row_id, stem_name) values
  ('aaaaaaaa-0000-4000-8000-00000000e201', 'aaaaaaaa-0000-4000-8000-00000000e0a0', 'aaaaaaaa-0000-4000-8000-00000000ec01', 'aaaaaaaa-0000-4000-8000-00000000e101', 'S1');
-- A node first recorded as fruit in 2026-W10 and harvested in W22 (12 weeks: long_development); one harvested at +7 (no flag).
insert into public.plant_nodes (id, organization_id, crop_id, measurement_stem_id, node_number) values
  ('aaaaaaaa-0000-4000-8000-00000000e301', 'aaaaaaaa-0000-4000-8000-00000000e0a0', 'aaaaaaaa-0000-4000-8000-00000000ec01', 'aaaaaaaa-0000-4000-8000-00000000e201', 1),
  ('aaaaaaaa-0000-4000-8000-00000000e302', 'aaaaaaaa-0000-4000-8000-00000000e0a0', 'aaaaaaaa-0000-4000-8000-00000000ec01', 'aaaaaaaa-0000-4000-8000-00000000e201', 2);
insert into public.node_observations (organization_id, crop_id, plant_node_id, year, week_number, status, observed_at, recorded_at)
select 'aaaaaaaa-0000-4000-8000-00000000e0a0', 'aaaaaaaa-0000-4000-8000-00000000ec01', n::uuid, 2026, w, s,
       to_date('2026-' || lpad(w::text, 2, '0'), 'IYYY-IW') + time '12:00', to_date('2026-' || lpad(w::text, 2, '0'), 'IYYY-IW') + time '12:00'
from (values ('aaaaaaaa-0000-4000-8000-00000000e301', 10, 'SetFruit'), ('aaaaaaaa-0000-4000-8000-00000000e301', 22, 'Harvested'),
             ('aaaaaaaa-0000-4000-8000-00000000e302', 10, 'SetFruit'), ('aaaaaaaa-0000-4000-8000-00000000e302', 17, 'Harvested')) as v(n, w, s);

-- The current greenhouse week (the lock rules use the server's clock).
create temporary table cw on commit drop as
select extract(isoyear from now() at time zone 'America/Toronto')::integer as y,
       extract(week from now() at time zone 'America/Toronto')::integer as w;
grant select on cw to authenticated;

-- Eight consecutive weeks after an origin, as the app sends them.
create function pg_temp.weeks(oy integer, ow integer, n integer default 8) returns jsonb language sql as $$
  select jsonb_agg(jsonb_build_object(
    'horizon', h,
    'target_year', extract(isoyear from to_date(oy || '-' || lpad(ow::text, 2, '0'), 'IYYY-IW') + 7 * h)::integer,
    'target_week', extract(week from to_date(oy || '-' || lpad(ow::text, 2, '0'), 'IYYY-IW') + 7 * h)::integer,
    'window', case when h <= 5 then 'marketing' else 'outlook' end,
    'sample_fruit', 10, 'sample_variance', 4, 'crop_fruit', 7000, 'components', jsonb_build_object('breaker', 5),
    'expected_aborted', 1, 'expected_pruned', 0.5, 'afw_g', 200, 'afw_source', 'test', 'afw_kind', case when h = 1 then 'grower' else 'model' end, 'kg', 1400) order by h)
  from generate_series(1, n) h
$$;
grant execute on function pg_temp.weeks(integer, integer, integer) to authenticated;

create function pg_temp.lock(run uuid, oy integer, ow integer, ev uuid, weeks jsonb default null)
returns table (run_id uuid, kind text, stored_now boolean, locked_at timestamptz) language sql as $$
  select * from public.lock_forecast_run(run, 'aaaaaaaa-0000-4000-8000-00000000ec01', oy, ow, ev, now(), 8, 5, 'engine-test', 'experimental',
    array['Trained mostly on legacy records'], '{"loadBands": 3}'::jsonb, '{"training": {"legacy": 100, "verified": 0}}'::jsonb, 1,
    array['aaaaaaaa-0000-4000-8000-00000000e201'::uuid], 700,
    '{"sample_fruit": 50, "crop_fruit": 35000, "kg": 7000}'::jsonb, coalesce(weeks, pg_temp.weeks(oy, ow)), 'lifecycle', null, null, 1)
$$;
grant execute on function pg_temp.lock(uuid, integer, integer, uuid, jsonb) to authenticated;

-- ── As user A ────────────────────────────────────────────────────────────────
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-4000-8000-00000000e001","role":"authenticated"}', true);

do $$
declare
  y integer := (select cw.y from cw);
  w integer := (select cw.w from cw);
  r record;
  n integer;
begin
  -- Not complete yet: nothing can be locked.
  begin
    perform pg_temp.lock('aaaaaaaa-0000-4000-8000-00000000f001', y, w, gen_random_uuid());
    raise exception 'FAIL: locked without a completed sampling week';
  exception when invalid_parameter_value then null;
  end;

  -- The sampled stem checked (a lock needs every sampled stem checked by completion: 20261024).
  insert into public.stem_visits (organization_id, crop_id, measurement_stem_id, year, week_number, checked, observed_at)
  values ('aaaaaaaa-0000-4000-8000-00000000e0a0', 'aaaaaaaa-0000-4000-8000-00000000ec01', 'aaaaaaaa-0000-4000-8000-00000000e201', y, w, true, now()),
         ('aaaaaaaa-0000-4000-8000-00000000e0a0', 'aaaaaaaa-0000-4000-8000-00000000ec01', 'aaaaaaaa-0000-4000-8000-00000000e201', 2026, 14, true, now());
  insert into public.sampling_week_events (id, organization_id, crop_id, year, week_number, event)
  values ('aaaaaaaa-0000-4000-8000-00000000e501', 'aaaaaaaa-0000-4000-8000-00000000e0a0', 'aaaaaaaa-0000-4000-8000-00000000ec01', y, w, 'completed');

  -- Wrong completion id, or weeks that don't line up: refused.
  begin
    perform pg_temp.lock('aaaaaaaa-0000-4000-8000-00000000f001', y, w, gen_random_uuid());
    raise exception 'FAIL: locked from a stale completion';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform pg_temp.lock('aaaaaaaa-0000-4000-8000-00000000f001', y, w, 'aaaaaaaa-0000-4000-8000-00000000e501', pg_temp.weeks(y, w, 7));
    raise exception 'FAIL: locked with 7 weeks for a horizon of 8';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform pg_temp.lock('aaaaaaaa-0000-4000-8000-00000000f001', y, w, 'aaaaaaaa-0000-4000-8000-00000000e501',
      jsonb_set(pg_temp.weeks(y, w), '{5,window}', '"marketing"'));
    raise exception 'FAIL: week 6 accepted in the marketing window';
  exception when invalid_parameter_value then null;
  end;

  -- Current week, completed now: on time.
  select * into r from pg_temp.lock('aaaaaaaa-0000-4000-8000-00000000f001', y, w, 'aaaaaaaa-0000-4000-8000-00000000e501');
  if r.kind <> 'official' or not r.stored_now or r.run_id <> 'aaaaaaaa-0000-4000-8000-00000000f001' then raise exception 'FAIL: first lock %', r; end if;
  select * into r from public.forecast_runs where id = 'aaaaaaaa-0000-4000-8000-00000000f001';
  if r.observed_cutoff is null or r.sampling_event_id <> 'aaaaaaaa-0000-4000-8000-00000000e501' or r.case_weight_kg <> 5
     or r.confidence <> 'experimental' or r.marketing_kg <> 7000 or r.horizon <> 8 or r.marketing_weeks <> 5 then
    raise exception 'FAIL: stored run %', r;
  end if;
  if (select count(*) from public.forecast_run_weeks where run_id = 'aaaaaaaa-0000-4000-8000-00000000f001') <> 8 then raise exception 'FAIL: 8 weeks stored'; end if;
  select count(*) into n from public.forecast_run_weeks where run_id = 'aaaaaaaa-0000-4000-8000-00000000f001' and "window" = 'outlook';
  if n <> 3 then raise exception 'FAIL: outlook weeks %', n; end if;
  if (select min(cases) from public.forecast_run_weeks where run_id = 'aaaaaaaa-0000-4000-8000-00000000f001') <> 280 then raise exception 'FAIL: cases = kg ÷ 5'; end if;
  if (select string_agg(afw_kind, ',' order by horizon) from public.forecast_run_weeks where run_id = 'aaaaaaaa-0000-4000-8000-00000000f001') <> 'grower,model,model,model,model,model,model,model' then
    raise exception 'FAIL: AFW kind stored per week';
  end if;
  if (select sample_stem_ids from public.forecast_runs where id = 'aaaaaaaa-0000-4000-8000-00000000f001') <> array['aaaaaaaa-0000-4000-8000-00000000e201'::uuid] then
    raise exception 'FAIL: sampled stems stored';
  end if;

  -- A second device, a retry, or a later re-completion: the stored run is returned, nothing is overwritten.
  select * into r from pg_temp.lock('aaaaaaaa-0000-4000-8000-00000000f002', y, w, 'aaaaaaaa-0000-4000-8000-00000000e501');
  if r.stored_now or r.run_id <> 'aaaaaaaa-0000-4000-8000-00000000f001' then raise exception 'FAIL: second lock %', r; end if;
  insert into public.sampling_week_events (id, organization_id, crop_id, year, week_number, event, recorded_at) values
    ('aaaaaaaa-0000-4000-8000-00000000e502', 'aaaaaaaa-0000-4000-8000-00000000e0a0', 'aaaaaaaa-0000-4000-8000-00000000ec01', y, w, 'reopened', now() + interval '1 second'),
    ('aaaaaaaa-0000-4000-8000-00000000e503', 'aaaaaaaa-0000-4000-8000-00000000e0a0', 'aaaaaaaa-0000-4000-8000-00000000ec01', y, w, 'completed', now() + interval '2 seconds');
  select * into r from pg_temp.lock('aaaaaaaa-0000-4000-8000-00000000f003', y, w, 'aaaaaaaa-0000-4000-8000-00000000e503');
  if r.stored_now or r.run_id <> 'aaaaaaaa-0000-4000-8000-00000000f001' then raise exception 'FAIL: re-completed week overwrote %', r; end if;
  if (select count(*) from public.forecast_runs where crop_id = 'aaaaaaaa-0000-4000-8000-00000000ec01') <> 1 then raise exception 'FAIL: more than one run for the week'; end if;

  -- A week completed after its first target week began: stored as late, never official.
  insert into public.sampling_week_events (id, organization_id, crop_id, year, week_number, event)
  values ('aaaaaaaa-0000-4000-8000-00000000e504', 'aaaaaaaa-0000-4000-8000-00000000e0a0', 'aaaaaaaa-0000-4000-8000-00000000ec01', 2026, 14, 'completed');
  select * into r from pg_temp.lock('aaaaaaaa-0000-4000-8000-00000000f004', 2026, 14, 'aaaaaaaa-0000-4000-8000-00000000e504');
  if r.kind <> 'late' or not r.stored_now then raise exception 'FAIL: late lock %', r; end if;
end $$;

-- Locked runs can't be changed or removed by clients.
do $$
begin
  update public.forecast_runs set kind = 'official';
  raise exception 'FAIL: forecast_runs can be updated';
exception when insufficient_privilege then null;
end $$;
do $$
begin
  delete from public.forecast_run_weeks;
  raise exception 'FAIL: forecast_run_weeks can be deleted';
exception when insufficient_privilege then null;
end $$;
do $$
begin
  insert into public.forecast_runs (id) values (gen_random_uuid());
  raise exception 'FAIL: clients can insert runs directly';
exception when insufficient_privilege then null;
end $$;

-- AFW changes are logged; an unchanged save isn't.
insert into public.weekly_harvest_afw (organization_id, crop_id, year, week, afw_g) values ('aaaaaaaa-0000-4000-8000-00000000e0a0', 'aaaaaaaa-0000-4000-8000-00000000ec01', 2026, 30, 210);
update public.weekly_harvest_afw set afw_g = 215 where crop_id = 'aaaaaaaa-0000-4000-8000-00000000ec01' and week = 30;
update public.weekly_harvest_afw set afw_g = 215 where crop_id = 'aaaaaaaa-0000-4000-8000-00000000ec01' and week = 30;
delete from public.weekly_harvest_afw where crop_id = 'aaaaaaaa-0000-4000-8000-00000000ec01' and week = 30;
do $$
declare got text;
begin
  select string_agg(action || ':' || coalesce(afw_g::text, '—'), ' ' order by id) into got
    from public.weekly_harvest_afw_log where crop_id = 'aaaaaaaa-0000-4000-8000-00000000ec01';
  if got is distinct from 'set:210.0 set:215.0 clear:—' then raise exception 'FAIL: AFW log %', got; end if;
end $$;
do $$
begin
  delete from public.weekly_harvest_afw_log;
  raise exception 'FAIL: the AFW log can be deleted';
exception when insufficient_privilege then null;
end $$;

-- long_development: 12 weeks from fruit to harvest is flagged for review; 7 weeks isn't.
do $$
declare r record;
begin
  select * into r from public.crop_quality_flags('aaaaaaaa-0000-4000-8000-00000000ec01') where rule_id = 'long_development';
  if r.plant_node_id <> 'aaaaaaaa-0000-4000-8000-00000000e301' or (r.evidence ->> 'weeks')::int <> 12 or r.review_decision is not null then
    raise exception 'FAIL: long_development %', r;
  end if;
  if (select count(*) from public.crop_quality_flags('aaaaaaaa-0000-4000-8000-00000000ec01') where rule_id = 'long_development') <> 1 then
    raise exception 'FAIL: only the 12-week fruit is flagged';
  end if;
end $$;

-- ── As user B (another organization) ─────────────────────────────────────────
select set_config('request.jwt.claims', '{"sub":"bbbbbbbb-0000-4000-8000-00000000e001","role":"authenticated"}', true);
do $$
begin
  if exists (select 1 from public.forecast_runs) or exists (select 1 from public.forecast_run_weeks) or exists (select 1 from public.weekly_harvest_afw_log) then
    raise exception 'FAIL: B sees A''s forecasts';
  end if;
  perform pg_temp.lock(gen_random_uuid(), 2026, 14, 'aaaaaaaa-0000-4000-8000-00000000e504');
  raise exception 'FAIL: B locked A''s forecast';
exception when insufficient_privilege then null;
end $$;

-- ── Even the owner of the tables can't change a locked run ───────────────────
reset role;
do $$
begin
  update public.forecast_runs set kind = 'official' where kind = 'late';
  raise exception 'FAIL: a locked run was changed';
exception when insufficient_privilege then null;
end $$;

-- ── anon ─────────────────────────────────────────────────────────────────────
select set_config('request.jwt.claims', '{"role":"anon"}', true);
set local role anon;
do $$
begin
  perform 1 from public.forecast_runs;
  raise exception 'FAIL: anon can read forecasts';
exception when insufficient_privilege then null;
end $$;

reset role;
select 'harvest_forecast_snapshots tests passed' as result;
rollback;
