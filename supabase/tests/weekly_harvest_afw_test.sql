-- weekly_harvest_afw: manual AFW (average grams per pepper harvested that week)
-- per crop / ISO year / harvest week — schema names, persistence, scope,
-- validation, organization isolation, and no effect on the cohort calculations.
--
-- Runs inside a transaction that is always rolled back, so it leaves nothing
-- behind. Any failed expectation raises and aborts the script.
--
--   npx supabase db query --linked -f supabase/tests/weekly_harvest_afw_test.sql
--
-- Prints a single row {"result": "weekly_harvest_afw tests passed"} on success.

begin;

-- The renamed schema: no table, column, constraint or function still says cohort / set week.
do $$
begin
  if to_regclass('public.cohort_afw') is not null then raise exception 'FAIL: cohort_afw still exists'; end if;
  if (select array_agg(column_name::text order by ordinal_position) from information_schema.columns
      where table_schema = 'public' and table_name = 'weekly_harvest_afw')
     <> array['organization_id', 'crop_id', 'year', 'week', 'afw_g', 'updated_by', 'created_at', 'updated_at'] then
    raise exception 'FAIL: weekly_harvest_afw columns';
  end if;
  if exists (select 1 from pg_constraint where conrelid = 'public.weekly_harvest_afw'::regclass and conname not like 'weekly_harvest_afw\_%') then
    raise exception 'FAIL: constraint still named for cohort_afw';
  end if;
  if to_regprocedure('public.cohort_afw_stamp()') is not null or to_regprocedure('public.weekly_harvest_afw_stamp()') is null then
    raise exception 'FAIL: stamp function name';
  end if;
  if not exists (select 1 from pg_trigger where tgrelid = 'public.weekly_harvest_afw'::regclass and tgname = 'weekly_harvest_afw_stamp') then
    raise exception 'FAIL: stamp trigger name';
  end if;
end $$;

insert into auth.users (id, email, aud, role) values
  ('c0000000-0000-4000-8000-0000000000a1', 'afw-test-a@example.invalid', 'authenticated', 'authenticated'),
  ('c0000000-0000-4000-8000-0000000000b1', 'afw-test-b@example.invalid', 'authenticated', 'authenticated');
insert into public.organizations (id, name) values
  ('c0000000-0000-4000-8000-00000000a000', 'AFW Org A'),
  ('c0000000-0000-4000-8000-00000000b000', 'AFW Org B');
insert into public.organization_members (organization_id, user_id, role) values
  ('c0000000-0000-4000-8000-00000000a000', 'c0000000-0000-4000-8000-0000000000a1', 'member'),
  ('c0000000-0000-4000-8000-00000000b000', 'c0000000-0000-4000-8000-0000000000b1', 'owner');
insert into public.crops (id, organization_id, name, color, planting_date, pullout_date, area_m2, picking_stems, created_by) values
  ('c0000000-0000-4000-8000-00000000a0c1', 'c0000000-0000-4000-8000-00000000a000', 'Crop A1', 'red', '2026-01-01', '2026-12-01', 11787, 80136, null),
  ('c0000000-0000-4000-8000-00000000a0c2', 'c0000000-0000-4000-8000-00000000a000', 'Crop A2', 'orange', '2026-01-01', '2026-12-01', 5000, 30000, null),
  ('c0000000-0000-4000-8000-00000000b0c1', 'c0000000-0000-4000-8000-00000000b000', 'Crop B', 'red', '2026-01-01', '2026-12-01', 100, 100, null);

-- Cohort results for every crop before any AFW is entered.
create temporary table cohorts_before as
  select c.id, h.* from public.crops c cross join lateral public.set_harvest_cohorts(c.id, 2026, '2026-10-05') h;
create temporary table weekly_before as
  select c.id, w.* from public.crops c cross join lateral public.weekly_plant_data(c.id, 2026, '2026-10-05') w;
grant select on cohorts_before, weekly_before to authenticated;

-- ---------------------------------------------------------------- user A (member)
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"c0000000-0000-4000-8000-0000000000a1","role":"authenticated"}', true);
do $$
declare v numeric;
begin
  -- Enter W34 = 200 g (as the Save button does: upsert), plus a future week.
  insert into public.weekly_harvest_afw (organization_id, crop_id, year, week, afw_g) values
    ('c0000000-0000-4000-8000-00000000a000', 'c0000000-0000-4000-8000-00000000a0c1', 2026, 34, 200),
    ('c0000000-0000-4000-8000-00000000a000', 'c0000000-0000-4000-8000-00000000a0c1', 2026, 50, 185.5)
    on conflict (crop_id, year, week) do update set afw_g = excluded.afw_g;
  -- Same week, other crop and other year are separate values.
  insert into public.weekly_harvest_afw (organization_id, crop_id, year, week, afw_g) values
    ('c0000000-0000-4000-8000-00000000a000', 'c0000000-0000-4000-8000-00000000a0c2', 2026, 34, 150),
    ('c0000000-0000-4000-8000-00000000a000', 'c0000000-0000-4000-8000-00000000a0c1', 2027, 34, 210);
  select afw_g into v from public.weekly_harvest_afw where crop_id = 'c0000000-0000-4000-8000-00000000a0c1' and year = 2026 and week = 34;
  if v <> 200 then raise exception 'FAIL: W34 AFW %', v; end if;
  select afw_g into v from public.weekly_harvest_afw where crop_id = 'c0000000-0000-4000-8000-00000000a0c2' and year = 2026 and week = 34;
  if v <> 150 then raise exception 'FAIL: other crop W34 AFW %', v; end if;
  select afw_g into v from public.weekly_harvest_afw where crop_id = 'c0000000-0000-4000-8000-00000000a0c1' and year = 2027 and week = 34;
  if v <> 210 then raise exception 'FAIL: other year W34 AFW %', v; end if;

  -- Change it: one row per week, value replaced, author stamped.
  insert into public.weekly_harvest_afw (organization_id, crop_id, year, week, afw_g) values
    ('c0000000-0000-4000-8000-00000000a000', 'c0000000-0000-4000-8000-00000000a0c1', 2026, 34, 195)
    on conflict (crop_id, year, week) do update set afw_g = excluded.afw_g;
  if (select count(*) from public.weekly_harvest_afw where crop_id = 'c0000000-0000-4000-8000-00000000a0c1' and year = 2026 and week = 34) <> 1
     or (select afw_g from public.weekly_harvest_afw where crop_id = 'c0000000-0000-4000-8000-00000000a0c1' and year = 2026 and week = 34) <> 195
     or (select updated_by from public.weekly_harvest_afw where crop_id = 'c0000000-0000-4000-8000-00000000a0c1' and year = 2026 and week = 34) <> 'c0000000-0000-4000-8000-0000000000a1' then
    raise exception 'FAIL: update';
  end if;

  -- Validation: positive, sensible grams, a real ISO week.
  begin insert into public.weekly_harvest_afw (organization_id, crop_id, year, week, afw_g) values ('c0000000-0000-4000-8000-00000000a000', 'c0000000-0000-4000-8000-00000000a0c1', 2026, 35, -5); raise exception 'FAIL: negative AFW';
  exception when check_violation then null; end;
  begin insert into public.weekly_harvest_afw (organization_id, crop_id, year, week, afw_g) values ('c0000000-0000-4000-8000-00000000a000', 'c0000000-0000-4000-8000-00000000a0c1', 2026, 35, 0); raise exception 'FAIL: zero AFW';
  exception when check_violation then null; end;
  begin insert into public.weekly_harvest_afw (organization_id, crop_id, year, week, afw_g) values ('c0000000-0000-4000-8000-00000000a000', 'c0000000-0000-4000-8000-00000000a0c1', 2026, 35, 2500); raise exception 'FAIL: 2.5 kg pepper';
  exception when check_violation then null; end;
  begin insert into public.weekly_harvest_afw (organization_id, crop_id, year, week, afw_g) values ('c0000000-0000-4000-8000-00000000a000', 'c0000000-0000-4000-8000-00000000a0c1', 2025, 53, 200); raise exception 'FAIL: W53 2025';
  exception when check_violation then null; end;
  -- 2026 has 53 ISO weeks.
  insert into public.weekly_harvest_afw (organization_id, crop_id, year, week, afw_g) values ('c0000000-0000-4000-8000-00000000a000', 'c0000000-0000-4000-8000-00000000a0c1', 2026, 53, 180);
  -- A crop of another organization can't be referenced with this organization id.
  begin insert into public.weekly_harvest_afw (organization_id, crop_id, year, week, afw_g) values ('c0000000-0000-4000-8000-00000000a000', 'c0000000-0000-4000-8000-00000000b0c1', 2026, 34, 200); raise exception 'FAIL: crop of another organization';
  exception when foreign_key_violation then null; end;

  -- Clearing a value deletes it.
  delete from public.weekly_harvest_afw where crop_id = 'c0000000-0000-4000-8000-00000000a0c1' and year = 2026 and week = 50;
  if exists (select 1 from public.weekly_harvest_afw where crop_id = 'c0000000-0000-4000-8000-00000000a0c1' and year = 2026 and week = 50) then raise exception 'FAIL: clear'; end if;
end $$;

-- ---------------------------------------------------------------- user B (other organization)
select set_config('request.jwt.claims', '{"sub":"c0000000-0000-4000-8000-0000000000b1","role":"authenticated"}', true);
do $$
begin
  if exists (select 1 from public.weekly_harvest_afw where organization_id = 'c0000000-0000-4000-8000-00000000a000') then raise exception 'FAIL: B reads A''s AFW'; end if;
  update public.weekly_harvest_afw set afw_g = 1 where organization_id = 'c0000000-0000-4000-8000-00000000a000';
  delete from public.weekly_harvest_afw where organization_id = 'c0000000-0000-4000-8000-00000000a000';
  begin
    insert into public.weekly_harvest_afw (organization_id, crop_id, year, week, afw_g) values ('c0000000-0000-4000-8000-00000000a000', 'c0000000-0000-4000-8000-00000000a0c1', 2026, 36, 200);
    raise exception 'FAIL: B wrote A''s AFW';
  exception when insufficient_privilege then null;
  end;
end $$;

-- ---------------------------------------------------------------- checks as the owner
reset role;
do $$
begin
  if (select afw_g from public.weekly_harvest_afw where crop_id = 'c0000000-0000-4000-8000-00000000a0c1' and year = 2026 and week = 34) <> 195
     or (select count(*) from public.weekly_harvest_afw where organization_id = 'c0000000-0000-4000-8000-00000000a000') <> 4 then
    raise exception 'FAIL: B changed or removed A''s AFW';
  end if;
  -- AFW changes none of the cohort calculations.
  if exists (
    (select * from cohorts_before except select c.id, h.* from public.crops c cross join lateral public.set_harvest_cohorts(c.id, 2026, '2026-10-05') h)
    union all
    (select c.id, h.* from public.crops c cross join lateral public.set_harvest_cohorts(c.id, 2026, '2026-10-05') h except select * from cohorts_before)
  ) then raise exception 'FAIL: set_harvest_cohorts changed'; end if;
  if exists (
    (select * from weekly_before except select c.id, w.* from public.crops c cross join lateral public.weekly_plant_data(c.id, 2026, '2026-10-05') w)
    union all
    (select c.id, w.* from public.crops c cross join lateral public.weekly_plant_data(c.id, 2026, '2026-10-05') w except select * from weekly_before)
  ) then raise exception 'FAIL: weekly_plant_data changed'; end if;
end $$;

-- anon sees nothing.
select set_config('request.jwt.claims', '{"role":"anon"}', true);
set local role anon;
do $$
begin
  perform count(*) from public.weekly_harvest_afw;
  raise exception 'FAIL: anon can read AFW';
exception when insufficient_privilege then null;
end $$;

reset role;
select 'weekly_harvest_afw tests passed' as result;
rollback;
