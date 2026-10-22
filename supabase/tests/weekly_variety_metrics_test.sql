-- 20261105000000_weekly_variety_metrics: weekly fruit counts per variety.
--
-- Runs inside a transaction that is always rolled back.
-- Prints {"result": "weekly_variety_metrics tests passed"} on success.

begin;

-- ── Fixture ──────────────────────────────────────────────────────────────────
-- Org A, crop A: Row 1 (S1, S2), Row 2 (S3).
--   W40  S1: n1 SetFruit, n2 Flower, shoot 1+1 (on n1) SetFruit.   S2: n3 BreakerFruit.   S3: nothing.
--   W41  S1: only "✓ Stem checked"; n1b, a second record of node 1, recorded MatureGreen (a duplicate).
--        S2: n3 Harvested.   S3: a growth reading only (visited, no fruit).
--   W42  nothing at all.
--   W43  S2: n5 BreakerFruit; n4 SetFruit, but n4 was removed (inactive).
insert into auth.users (id, email, aud, role) values
  ('eeeeeeee-0000-4000-8000-00000000e001', 'wm-a@example.invalid', 'authenticated', 'authenticated'),
  ('ffffffff-0000-4000-8000-00000000f001', 'wm-b@example.invalid', 'authenticated', 'authenticated');
insert into public.organizations (id, name) values
  ('eeeeeeee-0000-4000-8000-00000000e0a0', 'WM Org A'), ('ffffffff-0000-4000-8000-00000000f0b0', 'WM Org B');
insert into public.organization_members (organization_id, user_id, role) values
  ('eeeeeeee-0000-4000-8000-00000000e0a0', 'eeeeeeee-0000-4000-8000-00000000e001', 'member'),
  ('ffffffff-0000-4000-8000-00000000f0b0', 'ffffffff-0000-4000-8000-00000000f001', 'owner');
insert into public.crops (id, organization_id, name, color, planting_date, pullout_date, area_m2, picking_stems) values
  ('eeeeeeee-0000-4000-8000-00000000ec01', 'eeeeeeee-0000-4000-8000-00000000e0a0', 'Crop A', 'red', '2026-01-05', '2026-12-31', 100, 700),
  ('eeeeeeee-0000-4000-8000-00000000ec02', 'eeeeeeee-0000-4000-8000-00000000e0a0', 'Crop Empty', 'red', '2026-01-05', '2026-12-31', 100, 700),
  ('ffffffff-0000-4000-8000-00000000fc01', 'ffffffff-0000-4000-8000-00000000f0b0', 'Crop B', 'red', '2026-01-05', '2026-12-31', 100, 700);
insert into public.measurement_rows (id, organization_id, crop_id, row_name, sort_order) values
  ('eeeeeeee-0000-4000-8000-00000000e101', 'eeeeeeee-0000-4000-8000-00000000e0a0', 'eeeeeeee-0000-4000-8000-00000000ec01', 'Row 1', 1),
  ('eeeeeeee-0000-4000-8000-00000000e102', 'eeeeeeee-0000-4000-8000-00000000e0a0', 'eeeeeeee-0000-4000-8000-00000000ec01', 'Row 2', 2),
  ('ffffffff-0000-4000-8000-00000000f101', 'ffffffff-0000-4000-8000-00000000f0b0', 'ffffffff-0000-4000-8000-00000000fc01', 'Row B', 1);
insert into public.measurement_stems (id, organization_id, crop_id, measurement_row_id, stem_name, sort_order) values
  ('eeeeeeee-0000-4000-8000-00000000e201', 'eeeeeeee-0000-4000-8000-00000000e0a0', 'eeeeeeee-0000-4000-8000-00000000ec01', 'eeeeeeee-0000-4000-8000-00000000e101', 'S1', 1),
  ('eeeeeeee-0000-4000-8000-00000000e202', 'eeeeeeee-0000-4000-8000-00000000e0a0', 'eeeeeeee-0000-4000-8000-00000000ec01', 'eeeeeeee-0000-4000-8000-00000000e101', 'S2', 2),
  ('eeeeeeee-0000-4000-8000-00000000e203', 'eeeeeeee-0000-4000-8000-00000000e0a0', 'eeeeeeee-0000-4000-8000-00000000ec01', 'eeeeeeee-0000-4000-8000-00000000e102', 'S3', 1),
  ('ffffffff-0000-4000-8000-00000000f201', 'ffffffff-0000-4000-8000-00000000f0b0', 'ffffffff-0000-4000-8000-00000000fc01', 'ffffffff-0000-4000-8000-00000000f101', 'SB', 1);

-- Friday of week w, 2026, at noon Toronto.
create function pg_temp.fri(w integer) returns timestamptz language sql immutable as
  $$ select (to_date('2026-' || lpad(w::text, 2, '0'), 'IYYY-IW') + 4 + time '12:00') at time zone 'America/Toronto' $$;
create function pg_temp.id(s text) returns uuid language sql immutable as $$ select ('eeeeeeee-0000-4000-8000-0000000' || s)::uuid $$;

insert into public.plant_nodes (id, organization_id, crop_id, measurement_stem_id, node_number, is_side_shoot, parent_node_id, node_label, side, is_active, created_at)
select pg_temp.id(n), 'eeeeeeee-0000-4000-8000-00000000e0a0', 'eeeeeeee-0000-4000-8000-00000000ec01', pg_temp.id(stem), num, shoot, case when shoot then pg_temp.id('0e301') end,
       case when shoot then '1+1' end, case when shoot then 'right' end, active, created
from (values
  ('0e301', '0e201', 1, false, true, pg_temp.fri(40)),  -- n1
  ('0e302', '0e201', 2, false, true, pg_temp.fri(40)),  -- n2
  ('0e311', '0e201', 1, true, true, pg_temp.fri(40)),   -- shoot 1+1 on n1
  ('0e321', '0e201', 1, false, true, pg_temp.fri(41)),  -- n1b: node 1 again (duplicate)
  ('0e303', '0e202', 1, false, true, pg_temp.fri(40)),  -- n3
  ('0e304', '0e202', 2, false, false, pg_temp.fri(43)), -- n4, removed
  ('0e305', '0e202', 3, false, true, pg_temp.fri(43))   -- n5
) x(n, stem, num, shoot, active, created);
insert into public.plant_nodes (id, organization_id, crop_id, measurement_stem_id, node_number, created_at)
values ('ffffffff-0000-4000-8000-00000000f301', 'ffffffff-0000-4000-8000-00000000f0b0', 'ffffffff-0000-4000-8000-00000000fc01', 'ffffffff-0000-4000-8000-00000000f201', 1, pg_temp.fri(40));

insert into public.node_observations (organization_id, crop_id, plant_node_id, year, week_number, status, observed_at)
select 'eeeeeeee-0000-4000-8000-00000000e0a0', 'eeeeeeee-0000-4000-8000-00000000ec01', pg_temp.id(n), 2026, w, st, pg_temp.fri(w)
from (values
  ('0e301', 40, 'SetFruit'), ('0e302', 40, 'Flower'), ('0e311', 40, 'SetFruit'), ('0e303', 40, 'BreakerFruit'),
  ('0e321', 41, 'MatureGreen'), ('0e303', 41, 'Harvested'),
  ('0e305', 43, 'BreakerFruit'), ('0e304', 43, 'SetFruit')
) o(n, w, st);
insert into public.node_observations (organization_id, crop_id, plant_node_id, year, week_number, status, observed_at)
values ('ffffffff-0000-4000-8000-00000000f0b0', 'ffffffff-0000-4000-8000-00000000fc01', 'ffffffff-0000-4000-8000-00000000f301', 2026, 40, 'BreakerFruit', pg_temp.fri(40));
insert into public.stem_visits (organization_id, crop_id, measurement_stem_id, year, week_number, observed_at)
values ('eeeeeeee-0000-4000-8000-00000000e0a0', 'eeeeeeee-0000-4000-8000-00000000ec01', pg_temp.id('0e201'), 2026, 41, pg_temp.fri(41));
insert into public.stem_growth_measurements (organization_id, crop_id, measurement_stem_id, year, week_number, growth_cm, observed_at)
values ('eeeeeeee-0000-4000-8000-00000000e0a0', 'eeeeeeee-0000-4000-8000-00000000ec01', pg_temp.id('0e203'), 2026, 41, 5, pg_temp.fri(41));

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"eeeeeeee-0000-4000-8000-00000000e001","role":"authenticated"}', true);

do $$
declare got text;
begin
  select string_agg(format('%s:%s stems/%s rows set %s load %s brk %s', m.yw, m.stems, m.rows_, m.set_fruit, m.fruit_load, m.breakers), ' | ' order by m.yw)
    into got
    from public.weekly_variety_metrics('eeeeeeee-0000-4000-8000-00000000e0a0') m;
  -- W40: S1 + S2 visited (1 row): set n1 + shoot = 2; load n1, shoot, n3 = 3; breaker n3.
  -- W41: S1 (checked), S2, S3 (growth) visited (2 rows): node 1 counted once as its newest record (MatureGreen),
  --      the shoot still Set Fruit (carried within the visited stem), n2 a flower; n3 harvested; S3 empty.
  -- W42: no visit, no row.  W43: only S2 visited: n5 Breaker; removed n4 ignored; n3 stays harvested.
  -- Crop Empty has no visits, so no rows.
  if got <> '202640:2 stems/1 rows set 2 load 3 brk 1 | 202641:3 stems/2 rows set 1 load 2 brk 0 | 202643:1 stems/1 rows set 0 load 1 brk 1' then
    raise exception 'FAIL: metrics %', got;
  end if;
end $$;

-- Another organization's member sees nothing of org A.
select set_config('request.jwt.claims', '{"sub":"ffffffff-0000-4000-8000-00000000f001","role":"authenticated"}', true);
do $$
begin
  if exists (select 1 from public.weekly_variety_metrics('eeeeeeee-0000-4000-8000-00000000e0a0')) then raise exception 'FAIL: B sees A'; end if;
  if (select count(*) from public.weekly_variety_metrics('ffffffff-0000-4000-8000-00000000f0b0')) <> 1 then raise exception 'FAIL: B own'; end if;
end $$;
reset role;

set local role anon;
do $$
begin
  perform public.weekly_variety_metrics('eeeeeeee-0000-4000-8000-00000000e0a0');
  raise exception 'FAIL: anon';
exception when insufficient_privilege then null;
end $$;
reset role;

select '{"result": "weekly_variety_metrics tests passed"}';
rollback;
