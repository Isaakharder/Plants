-- 20261104000000_post_harvest_inspections: row-based harvests, post-harvest
-- inspections, harvest links and the forecast-lock pause.
--
-- Runs inside a transaction that is always rolled back.
-- Prints {"result": "post_harvest_inspections tests passed"} on success.

begin;

-- ── Fixture ──────────────────────────────────────────────────────────────────
-- Org A: Cadalora (rows 171, 172, 319), Silverstone (row 590), Bay Crop (row
-- "Bay A", no number). Owner A1 records harvests; member A2 inspects.
--   Row 171: S1 (n1 Breaker, n2 MatureGreen, n3 SetFruit, n4 Flower),
--            S2 (n5 Breaker, n10 Breaker, n12 Breaker seen after E1 finished)
--   Row 172: S3 (n6 Breaker, n9 Breaker)
--   Row 319: S4 (n7 Breaker, later Harvested outside any inspection)
-- Harvests (October 2026):
--   E0  Sat 10  Row 171 complete, no inspection
--   E1  Mon 12  Rows 160–180 complete, finished 14:00 → rows 171, 172
--   E2  Wed 14  Row 171 partial, finished 11:00
--   E3a Thu 15  Row 172 complete, finished 10:00
--   E3b Thu 15  Row 172 complete, finished 16:00 (a second harvest the same day)
insert into auth.users (id, email, aud, role) values
  ('cccccccc-0000-4000-8000-00000000d001', 'ph-owner@example.invalid', 'authenticated', 'authenticated'),
  ('cccccccc-0000-4000-8000-00000000d002', 'ph-member@example.invalid', 'authenticated', 'authenticated'),
  ('dddddddd-0000-4000-8000-00000000d003', 'ph-other@example.invalid', 'authenticated', 'authenticated');
insert into public.organizations (id, name) values
  ('cccccccc-0000-4000-8000-00000000d0a0', 'PH Org A'), ('dddddddd-0000-4000-8000-00000000d0b0', 'PH Org B');
insert into public.organization_members (organization_id, user_id, role) values
  ('cccccccc-0000-4000-8000-00000000d0a0', 'cccccccc-0000-4000-8000-00000000d001', 'owner'),
  ('cccccccc-0000-4000-8000-00000000d0a0', 'cccccccc-0000-4000-8000-00000000d002', 'member'),
  ('dddddddd-0000-4000-8000-00000000d0b0', 'dddddddd-0000-4000-8000-00000000d003', 'owner');
insert into public.crops (id, organization_id, name, color, planting_date, pullout_date, area_m2, picking_stems) values
  ('cccccccc-0000-4000-8000-00000000dc01', 'cccccccc-0000-4000-8000-00000000d0a0', 'Cadalora', 'red', '2026-01-05', '2026-12-01', 100, 700),
  ('cccccccc-0000-4000-8000-00000000dc02', 'cccccccc-0000-4000-8000-00000000d0a0', 'Silverstone', 'red', '2026-01-05', '2026-12-31', 100, 700),
  ('cccccccc-0000-4000-8000-00000000dc03', 'cccccccc-0000-4000-8000-00000000d0a0', 'Bay Crop', 'yellow', '2026-01-05', '2026-12-31', 100, 700);
insert into public.measurement_rows (id, organization_id, crop_id, row_name, sort_order) values
  ('cccccccc-0000-4000-8000-00000000d101', 'cccccccc-0000-4000-8000-00000000d0a0', 'cccccccc-0000-4000-8000-00000000dc01', 'Row 171', 1),
  ('cccccccc-0000-4000-8000-00000000d102', 'cccccccc-0000-4000-8000-00000000d0a0', 'cccccccc-0000-4000-8000-00000000dc01', 'Row 172', 2),
  ('cccccccc-0000-4000-8000-00000000d103', 'cccccccc-0000-4000-8000-00000000d0a0', 'cccccccc-0000-4000-8000-00000000dc01', 'Row 319', 3),
  ('cccccccc-0000-4000-8000-00000000d104', 'cccccccc-0000-4000-8000-00000000d0a0', 'cccccccc-0000-4000-8000-00000000dc02', 'Row 590', 1),
  ('cccccccc-0000-4000-8000-00000000d105', 'cccccccc-0000-4000-8000-00000000d0a0', 'cccccccc-0000-4000-8000-00000000dc03', 'Bay A', 1);
insert into public.measurement_stems (id, organization_id, crop_id, measurement_row_id, stem_name, sort_order)
select s::uuid, 'cccccccc-0000-4000-8000-00000000d0a0', 'cccccccc-0000-4000-8000-00000000dc01', r::uuid, name, ord
from (values
  ('cccccccc-0000-4000-8000-00000000d201', 'cccccccc-0000-4000-8000-00000000d101', 'S1', 1),
  ('cccccccc-0000-4000-8000-00000000d202', 'cccccccc-0000-4000-8000-00000000d101', 'S2', 2),
  ('cccccccc-0000-4000-8000-00000000d203', 'cccccccc-0000-4000-8000-00000000d102', 'S3', 1),
  ('cccccccc-0000-4000-8000-00000000d204', 'cccccccc-0000-4000-8000-00000000d103', 'S4', 1)
) x(s, r, name, ord);

-- Toronto local time → timestamptz.
create function pg_temp.at(d text, t text) returns timestamptz language sql immutable as
  $$ select (d::date + t::time) at time zone 'America/Toronto' $$;
create function pg_temp.node(n integer) returns uuid language sql immutable as
  $$ select ('cccccccc-0000-4000-8000-00000000d3' || lpad(n::text, 2, '0'))::uuid $$;
create function pg_temp.stem(n integer) returns uuid language sql immutable as
  $$ select ('cccccccc-0000-4000-8000-00000000d20' || n)::uuid $$;

insert into public.plant_nodes (id, organization_id, crop_id, measurement_stem_id, node_number, created_at)
select pg_temp.node(n), 'cccccccc-0000-4000-8000-00000000d0a0', 'cccccccc-0000-4000-8000-00000000dc01', pg_temp.stem(s), num, pg_temp.at('2026-10-02', '09:00')
from (values (1, 1, 1), (2, 1, 2), (3, 1, 3), (4, 1, 4), (5, 2, 1), (10, 2, 2), (12, 2, 3), (6, 3, 1), (9, 3, 2), (7, 4, 1)) x(n, s, num);

-- An observation (status, Toronto time) with its greenhouse week; returns its id.
create function pg_temp.obs(n integer, status text, ts timestamptz) returns uuid language sql as $$
  insert into public.node_observations (organization_id, crop_id, plant_node_id, year, week_number, status, observed_at)
  values ('cccccccc-0000-4000-8000-00000000d0a0', 'cccccccc-0000-4000-8000-00000000dc01', pg_temp.node(n),
          extract(isoyear from ts at time zone 'America/Toronto')::integer, extract(week from ts at time zone 'America/Toronto')::integer, status, ts)
  returning id
$$;

-- Ordinary records before the harvests (no inspection).
select pg_temp.obs(1, 'SetFruit', pg_temp.at('2026-10-02', '12:00')), pg_temp.obs(1, 'BreakerFruit', pg_temp.at('2026-10-09', '12:00')),
       pg_temp.obs(1, 'BreakerFruit', pg_temp.at('2026-10-12', '08:00')),  -- the morning of E1, before the harvest
       pg_temp.obs(2, 'MatureGreen', pg_temp.at('2026-10-09', '12:00')), pg_temp.obs(3, 'SetFruit', pg_temp.at('2026-10-09', '12:00')),
       pg_temp.obs(4, 'Flower', pg_temp.at('2026-10-09', '12:00')),
       pg_temp.obs(5, 'BreakerFruit', pg_temp.at('2026-10-09', '12:00')), pg_temp.obs(5, 'BreakerFruit', pg_temp.at('2026-10-11', '10:00')),
       pg_temp.obs(6, 'BreakerFruit', pg_temp.at('2026-10-09', '12:00')), pg_temp.obs(9, 'BreakerFruit', pg_temp.at('2026-10-09', '12:00')),
       pg_temp.obs(10, 'BreakerFruit', pg_temp.at('2026-10-09', '12:00')), pg_temp.obs(7, 'BreakerFruit', pg_temp.at('2026-10-09', '12:00')),
       pg_temp.obs(12, 'BreakerFruit', pg_temp.at('2026-10-12', '14:30'));  -- seen after E1 finished

create temp table ev (name text primary key, event_id uuid, version_id uuid, sampled_rows jsonb);
grant all on ev to authenticated;

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"cccccccc-0000-4000-8000-00000000d001","role":"authenticated"}', true);

-- ── 1. Recording harvests (owner A1) ─────────────────────────────────────────
insert into ev select 'E0', r.event_id, r.version_id, r.sampled_rows from public.record_harvest_event(
  'cccccccc-0000-4000-8000-00000000dc01', '2026-10-10', null, 80, '[{"from":171,"to":171,"coverage":"complete"}]') r;
insert into ev select 'E1', r.event_id, r.version_id, r.sampled_rows from public.record_harvest_event(
  'cccccccc-0000-4000-8000-00000000dc01', '2026-10-12', pg_temp.at('2026-10-12', '14:00'), 85, '[{"from":160,"to":180,"coverage":"complete"}]', 512.5) r;
insert into ev select 'E2', r.event_id, r.version_id, r.sampled_rows from public.record_harvest_event(
  'cccccccc-0000-4000-8000-00000000dc01', '2026-10-14', pg_temp.at('2026-10-14', '11:00'), 90, '[{"from":171,"to":171,"coverage":"partial"}]') r;
insert into ev select 'E3a', r.event_id, r.version_id, r.sampled_rows from public.record_harvest_event(
  'cccccccc-0000-4000-8000-00000000dc01', '2026-10-15', pg_temp.at('2026-10-15', '10:00'), 90, '[{"from":172,"to":172,"coverage":"complete"}]') r;
insert into ev select 'E3b', r.event_id, r.version_id, r.sampled_rows from public.record_harvest_event(
  'cccccccc-0000-4000-8000-00000000dc01', '2026-10-15', pg_temp.at('2026-10-15', '16:00'), 90, '[{"from":172,"to":172,"coverage":"complete"}]') r;
-- Two ranges, one with no sampled row (still accepted: it is part of the calendar).
insert into ev select 'Ex', r.event_id, r.version_id, r.sampled_rows from public.record_harvest_event(
  'cccccccc-0000-4000-8000-00000000dc01', '2026-10-16', null, 80,
  '[{"from":400,"to":410,"coverage":"complete"},{"from":319,"to":319,"coverage":"partial"}]', null, 'test', null, false,
  'cccccccc-0000-4000-8000-00000000d901') r;

do $$
begin
  if (select sampled_rows from ev where name = 'E1') <> '[{"row_id": "cccccccc-0000-4000-8000-00000000d101", "row_name": "Row 171", "coverage": "complete", "row_number": 171},
      {"row_id": "cccccccc-0000-4000-8000-00000000d102", "row_name": "Row 172", "coverage": "complete", "row_number": 172}]'::jsonb then
    raise exception 'FAIL: E1 sampled rows %', (select sampled_rows from ev where name = 'E1');
  end if;
  if jsonb_array_length((select sampled_rows from ev where name = 'Ex')) <> 1 then raise exception 'FAIL: Ex rows'; end if;
  if (select event_id = version_id from ev where name = 'E1') is not true then raise exception 'FAIL: first version is the event'; end if;
  -- A retry with the same id returns the same version, nothing new.
  if (select r.version_id from public.record_harvest_event('cccccccc-0000-4000-8000-00000000dc01', '2026-10-16', null, 80,
        '[{"from":400,"to":410,"coverage":"complete"}]', null, null, null, false, 'cccccccc-0000-4000-8000-00000000d901') r)
     <> 'cccccccc-0000-4000-8000-00000000d901' or (select count(*) from public.harvest_events) <> 6 then
    raise exception 'FAIL: retry';
  end if;
  if public.greenhouse_row_number('Row 171') <> 171 or public.greenhouse_row_number(' row171 ') <> 171 or public.greenhouse_row_number('R 9') <> 9
     or public.greenhouse_row_number('171') <> 171 or public.greenhouse_row_number('Bay A') is not null or public.greenhouse_row_number('Row 17 1') is not null then
    raise exception 'FAIL: greenhouse_row_number';
  end if;
end $$;

-- Rejected harvests: each must raise 22023 (with the reason where it matters).
create function pg_temp.rejects(p_date date, p_finished timestamptz, p_colour numeric, p_ranges jsonb, p_expect text) returns void language plpgsql as $$
begin
  perform public.record_harvest_event('cccccccc-0000-4000-8000-00000000dc01', p_date, p_finished, p_colour, p_ranges);
  raise exception 'FAIL: accepted (%)', p_expect;
exception when sqlstate '22023' then
  if sqlerrm not ilike '%' || p_expect || '%' then raise exception 'FAIL: wrong reason for % — %', p_expect, sqlerrm; end if;
end $$;
select pg_temp.rejects('2099-01-01', null, 80, '[{"from":171,"to":171,"coverage":"complete"}]', 'outside Cadalora');
select pg_temp.rejects((now() at time zone 'America/Toronto')::date + 1, null, 80, '[{"from":171,"to":171,"coverage":"complete"}]', 'in the future');
select pg_temp.rejects('2025-12-01', null, 80, '[{"from":171,"to":171,"coverage":"complete"}]', 'outside Cadalora');
select pg_temp.rejects('2026-10-12', pg_temp.at('2026-10-13', '09:00'), 80, '[{"from":171,"to":171,"coverage":"complete"}]', 'finish time');
select pg_temp.rejects('2026-10-12', null, 120, '[{"from":171,"to":171,"coverage":"complete"}]', 'minimum mature colour');
select pg_temp.rejects('2026-10-12', null, null, '[{"from":171,"to":171,"coverage":"complete"}]', 'minimum mature colour');
select pg_temp.rejects('2026-10-12', null, 80, '[]', 'between 1 and 20');
select pg_temp.rejects('2026-10-12', null, 80, '[{"from":180,"to":160,"coverage":"complete"}]', 'not a valid range');
select pg_temp.rejects('2026-10-12', null, 80, '[{"from":160,"to":180,"coverage":"most"}]', 'not a valid range');
select pg_temp.rejects('2026-10-12', null, 80, '[{"from":"abc","to":180,"coverage":"complete"}]', 'whole row numbers');
select pg_temp.rejects('2026-10-12', null, 80, '[{"from":160.5,"to":180,"coverage":"complete"}]', 'whole row numbers');
select pg_temp.rejects('2026-10-12', null, 80, '[{"from":160,"to":175,"coverage":"complete"},{"from":170,"to":180,"coverage":"partial"}]', 'overlap');
select pg_temp.rejects('2026-10-12', null, 80, '[{"from":580,"to":600,"coverage":"complete"}]', 'Row 590 is a sampled row of Silverstone');

do $$
begin
  -- A variety whose sampled rows carry no number can't take ranges.
  begin
    perform public.record_harvest_event('cccccccc-0000-4000-8000-00000000dc03', '2026-10-12', null, 80, '[{"from":1,"to":5,"coverage":"complete"}]');
    raise exception 'FAIL: unnumbered rows accepted';
  exception when sqlstate '22023' then
    if sqlerrm not like '%Bay A%' then raise exception 'FAIL: unnumbered reason %', sqlerrm; end if;
  end;
  -- Direct writes are refused: only record_harvest_event writes harvests.
  begin
    insert into public.harvest_events (event_id, organization_id, crop_id, harvest_date, min_colour_percent, recorded_by)
      values (gen_random_uuid(), 'cccccccc-0000-4000-8000-00000000d0a0', 'cccccccc-0000-4000-8000-00000000dc01', '2026-10-12', 80, auth.uid());
    raise exception 'FAIL: direct insert';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.harvest_events set min_colour_percent = 10;
    raise exception 'FAIL: update';
  exception when insufficient_privilege then null;
  end;
end $$;

-- ── 2. Corrections and cancellation ──────────────────────────────────────────
do $$
declare v_new uuid; r record;
begin
  -- Correct Ex (kg added); the first version stays stored.
  select x.version_id into v_new from public.record_harvest_event('cccccccc-0000-4000-8000-00000000dc01', '2026-10-16', null, 80,
    '[{"from":400,"to":410,"coverage":"complete"}]', 120, 'kg added', 'cccccccc-0000-4000-8000-00000000d901') x;
  select * into r from public.harvest_events_in_effect('cccccccc-0000-4000-8000-00000000d0a0', 'cccccccc-0000-4000-8000-00000000dc01')
   where event_id = 'cccccccc-0000-4000-8000-00000000d901';
  if r.version_id <> v_new or r.versions <> 2 or r.harvested_kg <> 120 or r.cancelled or jsonb_array_length(r.sampled_rows) <> 0 then
    raise exception 'FAIL: correction %', r;
  end if;
  -- Correcting the old version again: someone else changed it.
  begin
    perform public.record_harvest_event('cccccccc-0000-4000-8000-00000000dc01', '2026-10-16', null, 80,
      '[{"from":400,"to":410,"coverage":"complete"}]', 130, null, 'cccccccc-0000-4000-8000-00000000d901');
    raise exception 'FAIL: stale correction accepted';
  exception when sqlstate '40001' then null;
  end;
  -- Cancelling needs a reason, then keeps the harvest's data.
  begin
    perform public.record_harvest_event('cccccccc-0000-4000-8000-00000000dc01', null, null, null, null, null, ' ', v_new, true);
    raise exception 'FAIL: cancel without reason';
  exception when sqlstate '22023' then null;
  end;
  perform public.record_harvest_event('cccccccc-0000-4000-8000-00000000dc01', null, null, null, null, null, 'Entered twice', v_new, true);
  select * into r from public.harvest_events_in_effect('cccccccc-0000-4000-8000-00000000d0a0', 'cccccccc-0000-4000-8000-00000000dc01')
   where event_id = 'cccccccc-0000-4000-8000-00000000d901';
  if not r.cancelled or r.versions <> 3 or r.harvested_kg <> 120 or r.harvest_date <> '2026-10-16' or r.note <> 'Entered twice' then
    raise exception 'FAIL: cancel %', r;
  end if;
  begin
    perform public.record_harvest_event('cccccccc-0000-4000-8000-00000000dc01', '2026-10-16', null, 80,
      '[{"from":400,"to":410,"coverage":"complete"}]', null, null, r.version_id);
    raise exception 'FAIL: cancelled harvest changed';
  exception when sqlstate '22023' then null;
  end;
  if (select count(*) from public.harvest_events where event_id = 'cccccccc-0000-4000-8000-00000000d901') <> 3 then raise exception 'FAIL: history kept'; end if;
end $$;

-- ── 3. Inspections (member A2) ───────────────────────────────────────────────
select set_config('request.jwt.claims', '{"sub":"cccccccc-0000-4000-8000-00000000d002","role":"authenticated"}', true);

create function pg_temp.answer(n integer, status text, ts timestamptz, harvest text) returns void language sql as $$
  insert into public.harvest_inspection_answers (node_observation_id, harvest_event_id, organization_id, crop_id)
  values (pg_temp.obs(n, status, ts), (select event_id from ev where name = harvest), 'cccccccc-0000-4000-8000-00000000d0a0', 'cccccccc-0000-4000-8000-00000000dc01')
$$;
create function pg_temp.check_stem(s integer, ts timestamptz, harvest text, all_fruit boolean default true, checked boolean default true) returns void language sql as $$
  insert into public.stem_visits (organization_id, crop_id, measurement_stem_id, year, week_number, checked, observed_at, harvest_event_id, all_fruit_checked)
  values ('cccccccc-0000-4000-8000-00000000d0a0', 'cccccccc-0000-4000-8000-00000000dc01', pg_temp.stem(s),
          extract(isoyear from ts at time zone 'America/Toronto')::integer, extract(week from ts at time zone 'America/Toronto')::integer,
          checked, ts, (select event_id from ev where name = harvest), all_fruit)
$$;
create function pg_temp.new_node(n integer, s integer, num integer, ts timestamptz) returns void language sql as $$
  insert into public.plant_nodes (id, organization_id, crop_id, measurement_stem_id, node_number, created_at)
  values (pg_temp.node(n), 'cccccccc-0000-4000-8000-00000000d0a0', 'cccccccc-0000-4000-8000-00000000dc01', pg_temp.stem(s), num, ts)
$$;

-- E1, Monday 12th after 14:00.
select pg_temp.answer(1, 'Harvested', pg_temp.at('2026-10-12', '15:00'), 'E1'),
       pg_temp.answer(2, 'MatureGreen', pg_temp.at('2026-10-12', '15:01'), 'E1');
-- Not complete yet: n3 is unanswered, so "all fruit checked" doesn't make it complete.
select pg_temp.check_stem(1, pg_temp.at('2026-10-12', '15:02'), 'E1');
do $$
declare r record;
begin
  select * into r from public.post_harvest_inspection_stems('cccccccc-0000-4000-8000-00000000dc01')
   where event_id = (select event_id from ev where name = 'E1') and measurement_stem_id = pg_temp.stem(1);
  if r.state <> 'in_progress' or r.to_confirm <> 3 or r.answered <> 2 or r.unanswered <> 1 then raise exception 'FAIL: S1 partly answered %', r; end if;
end $$;
select pg_temp.answer(3, 'SetFruit', pg_temp.at('2026-10-12', '15:03'), 'E1'),
       pg_temp.new_node(8, 1, 5, pg_temp.at('2026-10-12', '15:04')), pg_temp.answer(8, 'SetFruit', pg_temp.at('2026-10-12', '15:04'), 'E1'),
       pg_temp.new_node(11, 1, 6, pg_temp.at('2026-10-12', '15:05')), pg_temp.answer(11, 'Harvested', pg_temp.at('2026-10-12', '15:05'), 'E1'),
       pg_temp.check_stem(1, pg_temp.at('2026-10-12', '15:06'), 'E1');
select pg_temp.answer(5, 'Harvested', pg_temp.at('2026-10-12', '15:10'), 'E1'),
       pg_temp.answer(10, 'Harvested', pg_temp.at('2026-10-12', '15:11'), 'E1'),
       pg_temp.answer(12, 'Harvested', pg_temp.at('2026-10-12', '15:12'), 'E1'),
       pg_temp.check_stem(2, pg_temp.at('2026-10-12', '15:13'), 'E1');
select pg_temp.answer(6, 'Harvested', pg_temp.at('2026-10-12', '15:20'), 'E1');  -- S3: n9 never answered, no check

-- E2, Wednesday 14th (row 171 partly harvested).
select pg_temp.answer(2, 'Harvested', pg_temp.at('2026-10-14', '12:00'), 'E2'),
       pg_temp.answer(3, 'SetFruit', pg_temp.at('2026-10-14', '12:01'), 'E2'),
       pg_temp.answer(8, 'MatureGreen', pg_temp.at('2026-10-14', '12:02'), 'E2'),
       pg_temp.check_stem(1, pg_temp.at('2026-10-14', '12:03'), 'E2'),
       pg_temp.check_stem(2, pg_temp.at('2026-10-14', '12:10'), 'E2');

-- E3a, Thursday 15th, checked after the second harvest of the day (E3b) finished.
select pg_temp.answer(9, 'Harvested', pg_temp.at('2026-10-15', '16:50'), 'E3a'),
       pg_temp.check_stem(3, pg_temp.at('2026-10-15', '17:00'), 'E3a');

-- n7 (row 319) recorded Harvested on an ordinary Friday visit.
select pg_temp.obs(7, 'Harvested', pg_temp.at('2026-10-16', '12:00'));

do $$
declare r record; got text;
begin
  select string_agg(format('%s/%s:%s %s/%s/%s new%s h%s%s', e.name, s.stem_name, s.state, s.to_confirm, s.answered, s.unanswered, s.new_nodes, s.harvested,
                           case when s.later_harvest then ' later' else '' end), ' | ' order by e.name, s.stem_name)
    into got
    from public.post_harvest_inspection_stems('cccccccc-0000-4000-8000-00000000dc01') s join ev e on e.event_id = s.event_id;
  if got <> 'E0/S1:not_started 2/0/2 new0 h0 later | E0/S2:not_started 0/0/0 new0 h0 later | '
          || 'E1/S1:complete 3/3/0 new2 h2 | E1/S2:complete 3/3/0 new0 h3 | E1/S3:in_progress 1/1/0 new0 h1 later | '
          || 'E2/S1:complete 3/3/0 new0 h1 | E2/S2:complete 0/0/0 new0 h0 | '
          || 'E3a/S3:complete 1/1/0 new0 h1 later | E3b/S3:not_started 0/0/0 new0 h0' then
    raise exception 'FAIL: inspection progress %', got;
  end if;
  -- An inspection without a completed check lists what is on the plant now (E0/S1: n3, n8), and
  -- every later harvest of its rows counts against it.

  -- An inspection check counts as the week's ordinary stem visit too.
  if not exists (select 1 from public.crop_stem_weeks('cccccccc-0000-4000-8000-00000000dc01') w
                  where w.measurement_stem_id = pg_temp.stem(2) and w.yw = 202642 and w.visited) then
    raise exception 'FAIL: inspection check is not a visit';
  end if;
end $$;

-- ── 4. Harvest links ─────────────────────────────────────────────────────────
create function pg_temp.links() returns text language sql as $$
  select string_agg(format('n%s:%s%s', right(l.plant_node_id::text, 2)::integer, l.link_status,
                           coalesce('@' || l.harvest_date, '') || coalesce('[' || (select string_agg(e.name, ',' order by e.name) from ev e where e.event_id = any (l.candidate_event_ids)) || ']', '')),
                    ' ' order by right(l.plant_node_id::text, 2)::integer)
    from public.fruit_harvest_links('cccccccc-0000-4000-8000-00000000dc01') l
$$;
do $$
declare got text := pg_temp.links();
begin
  if got <> 'n1:inferred@2026-10-12[E1] n2:partial_row[E2] n5:inferred@2026-10-12[E1] n6:inspection_incomplete[E1] '
          || 'n7:not_from_inspection n9:later_harvest[E1,E3a,E3b] n10:several_possible[E0,E1] n11:no_earlier_record[E0,E1] n12:no_matching_harvest' then
    raise exception 'FAIL: links %', got;
  end if;
end $$;

-- Reviews: confirm n10 in E0, reject n1, then reopen n1.
do $$
begin
  insert into public.harvest_link_reviews (organization_id, crop_id, node_observation_id, decision, harvest_event_id, note)
  select 'cccccccc-0000-4000-8000-00000000d0a0', 'cccccccc-0000-4000-8000-00000000dc01', l.node_observation_id, 'confirmed', (select event_id from ev where name = 'E0'), 'Picker confirmed'
    from public.fruit_harvest_links('cccccccc-0000-4000-8000-00000000dc01') l where l.plant_node_id = pg_temp.node(10);
  insert into public.harvest_link_reviews (organization_id, crop_id, node_observation_id, decision, note)
  select 'cccccccc-0000-4000-8000-00000000d0a0', 'cccccccc-0000-4000-8000-00000000dc01', l.node_observation_id, 'rejected', 'Dropped, not picked'
    from public.fruit_harvest_links('cccccccc-0000-4000-8000-00000000dc01') l where l.plant_node_id = pg_temp.node(1);
  if pg_temp.links() not like 'n1:rejected[E1] %n10:confirmed@2026-10-10[E0,E1] %' then raise exception 'FAIL: reviewed %', pg_temp.links(); end if;
  insert into public.harvest_link_reviews (organization_id, crop_id, node_observation_id, decision)
  select 'cccccccc-0000-4000-8000-00000000d0a0', 'cccccccc-0000-4000-8000-00000000dc01', l.node_observation_id, 'unreviewed'
    from public.fruit_harvest_links('cccccccc-0000-4000-8000-00000000dc01') l where l.plant_node_id = pg_temp.node(1);
  if pg_temp.links() not like 'n1:inferred@2026-10-12[E1] %' then raise exception 'FAIL: reopened %', pg_temp.links(); end if;
  -- Confirmed needs a harvest; only Harvested records; never edited; not in another's name.
  begin
    insert into public.harvest_link_reviews (organization_id, crop_id, node_observation_id, decision)
    select 'cccccccc-0000-4000-8000-00000000d0a0', 'cccccccc-0000-4000-8000-00000000dc01', l.node_observation_id, 'confirmed'
      from public.fruit_harvest_links('cccccccc-0000-4000-8000-00000000dc01') l where l.plant_node_id = pg_temp.node(5);
    raise exception 'FAIL: confirmed without harvest';
  exception when check_violation then null;
  end;
  begin
    insert into public.harvest_link_reviews (organization_id, crop_id, node_observation_id, decision)
    select 'cccccccc-0000-4000-8000-00000000d0a0', 'cccccccc-0000-4000-8000-00000000dc01', o.id, 'rejected'
      from public.node_observations o where o.plant_node_id = pg_temp.node(3) limit 1;
    raise exception 'FAIL: review of a non-Harvested record';
  exception when sqlstate '23514' then null;
  end;
  begin
    update public.harvest_link_reviews set note = 'x';
    raise exception 'FAIL: review edited';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.harvest_link_reviews (organization_id, crop_id, node_observation_id, decision, reviewed_by)
    select 'cccccccc-0000-4000-8000-00000000d0a0', 'cccccccc-0000-4000-8000-00000000dc01', l.node_observation_id, 'rejected', 'cccccccc-0000-4000-8000-00000000d001'
      from public.fruit_harvest_links('cccccccc-0000-4000-8000-00000000dc01') l where l.plant_node_id = pg_temp.node(5);
    raise exception 'FAIL: review in another name';
  exception when insufficient_privilege then null;
  end;
end $$;

-- Inspection records must stay within the variety; server times can't be chosen.
do $$
begin
  begin
    insert into public.stem_visits (organization_id, crop_id, measurement_stem_id, year, week_number, observed_at, harvest_event_id, all_fruit_checked)
    values ('cccccccc-0000-4000-8000-00000000d0a0', 'cccccccc-0000-4000-8000-00000000dc01', pg_temp.stem(1), 2026, 43, now(),
            (select version_id from public.harvest_events_in_effect('cccccccc-0000-4000-8000-00000000d0a0', 'cccccccc-0000-4000-8000-00000000dc01')
              where event_id = 'cccccccc-0000-4000-8000-00000000d901'), true);
    raise exception 'FAIL: check names a later version, not the harvest';
  exception when sqlstate '23514' then null;
  end;
  begin
    insert into public.stem_visits (organization_id, crop_id, measurement_stem_id, year, week_number, observed_at, harvest_event_id)
    values ('cccccccc-0000-4000-8000-00000000d0a0', 'cccccccc-0000-4000-8000-00000000dc01', pg_temp.stem(1), 2026, 43, now(), (select event_id from ev where name = 'E1'));
    raise exception 'FAIL: inspection check without all_fruit_checked';
  exception when check_violation then null;
  end;
  begin
    insert into public.harvest_inspection_answers (node_observation_id, harvest_event_id, organization_id, crop_id, recorded_at)
    values (pg_temp.obs(3, 'SetFruit', now()), (select event_id from ev where name = 'E1'), 'cccccccc-0000-4000-8000-00000000d0a0', 'cccccccc-0000-4000-8000-00000000dc01', '2020-01-01');
    raise exception 'FAIL: recorded_at chosen by the client';
  exception when insufficient_privilege then null;
  end;
  -- An ordinary check (no harvest) is unchanged.
  insert into public.stem_visits (organization_id, crop_id, measurement_stem_id, year, week_number, observed_at)
  values ('cccccccc-0000-4000-8000-00000000d0a0', 'cccccccc-0000-4000-8000-00000000dc01', pg_temp.stem(4), 2026, 42, pg_temp.at('2026-10-16', '12:05'));
end $$;

-- ── 5. Inventory: each stem's latest records, whatever day ───────────────────
do $$
declare got text;
begin
  select string_agg(format('%s:%s/%s/%s%s', i.stem_name, i.set_fruit, i.mature_green, i.breakers,
                           coalesce(' ' || (select e.name from ev e where e.event_id = i.last_inspection_event_id), '')), ' ' order by i.stem_name)
    into got from public.stem_inventory_latest('cccccccc-0000-4000-8000-00000000dc01') i;
  if got <> 'S1:1/1/0 E2 S2:0/0/0 E2 S3:0/0/0 E3a S4:0/0/0' then raise exception 'FAIL: inventory %', got; end if;
end $$;

-- ── 6. Another organization and anon ─────────────────────────────────────────
select set_config('request.jwt.claims', '{"sub":"dddddddd-0000-4000-8000-00000000d003","role":"authenticated"}', true);
do $$
begin
  if exists (select 1 from public.harvest_events) or exists (select 1 from public.harvest_inspection_answers)
     or exists (select 1 from public.harvest_events_in_effect('cccccccc-0000-4000-8000-00000000d0a0'))
     or exists (select 1 from public.fruit_harvest_links('cccccccc-0000-4000-8000-00000000dc01')) then
    raise exception 'FAIL: B sees A''s harvests';
  end if;
  begin
    perform public.record_harvest_event('cccccccc-0000-4000-8000-00000000dc01', '2026-10-12', null, 80, '[{"from":171,"to":171,"coverage":"complete"}]');
    raise exception 'FAIL: B recorded A''s harvest';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;
set local role anon;
do $$
begin
  perform 1 from public.harvest_events;
  raise exception 'FAIL: anon reads harvests';
exception when insufficient_privilege then null;
end $$;
reset role;

-- Even the table owner can't rewrite harvest history.
do $$
begin
  delete from public.harvest_event_ranges;
  raise exception 'FAIL: ranges deleted';
exception when insufficient_privilege then null;
end $$;

-- ── 7. Forecast locking paused from the first post-harvest week ─────────────
-- Cadalora's first harvest is Sat 10 Oct (2026-W41). Silverstone has none.
do $$
declare j record;
begin
  if public.post_harvest_workflow_from('cccccccc-0000-4000-8000-00000000dc01') <> 202641
     or public.post_harvest_workflow_from('cccccccc-0000-4000-8000-00000000dc02') is not null then
    raise exception 'FAIL: workflow start %', public.post_harvest_workflow_from('cccccccc-0000-4000-8000-00000000dc01');
  end if;
  insert into public.sampling_week_events (id, organization_id, crop_id, year, week_number, event, observed_at) values
    ('cccccccc-0000-4000-8000-00000000d940', 'cccccccc-0000-4000-8000-00000000d0a0', 'cccccccc-0000-4000-8000-00000000dc01', 2026, 40, 'completed', pg_temp.at('2026-10-02', '15:00')),
    ('cccccccc-0000-4000-8000-00000000d942', 'cccccccc-0000-4000-8000-00000000d0a0', 'cccccccc-0000-4000-8000-00000000dc01', 2026, 42, 'completed', pg_temp.at('2026-10-16', '15:00')),
    ('cccccccc-0000-4000-8000-00000000d952', 'cccccccc-0000-4000-8000-00000000d0a0', 'cccccccc-0000-4000-8000-00000000dc02', 2026, 42, 'completed', pg_temp.at('2026-10-16', '15:00'));
  select * into j from public.forecast_lock_jobs where sampling_event_id = 'cccccccc-0000-4000-8000-00000000d942';
  if j.status <> 'paused' or j.last_error not like '%paused from 2026-W41%' then raise exception 'FAIL: W42 job %', j; end if;
  if (select status from public.forecast_lock_jobs where sampling_event_id = 'cccccccc-0000-4000-8000-00000000d940') <> 'pending'
     or (select status from public.forecast_lock_jobs where sampling_event_id = 'cccccccc-0000-4000-8000-00000000d952') <> 'pending' then
    raise exception 'FAIL: earlier week / other variety not pending';
  end if;
  -- Paused jobs are never claimed.
  if exists (select 1 from public.forecast_lock_jobs where status = 'paused' and sampling_event_id <> 'cccccccc-0000-4000-8000-00000000d942') then
    raise exception 'FAIL: unexpected paused job';
  end if;
end $$;

create function pg_temp.lock_run(week integer, event uuid) returns void language sql as $$
  insert into public.forecast_runs (id, organization_id, crop_id, origin_year, origin_week, kind, sampling_event_id, observed_cutoff, recorded_cutoff,
                                    first_target_starts, horizon, marketing_weeks, engine_version, confidence, model, data_summary, sample_stems,
                                    sample_stem_ids, scale, marketing_sample_fruit, marketing_crop_fruit)
  values (gen_random_uuid(), 'cccccccc-0000-4000-8000-00000000d0a0', 'cccccccc-0000-4000-8000-00000000dc01', 2026, week, 'official', event, now(), now(),
          now(), 1, 1, 'test', 'experimental', '{}', '{}', 0, '{}', 0, 0, 0)
$$;
-- A week before the new workflow still locks; a week in it doesn't.
select pg_temp.lock_run(40, 'cccccccc-0000-4000-8000-00000000d940');
do $$
begin
  perform pg_temp.lock_run(42, 'cccccccc-0000-4000-8000-00000000d942');
  raise exception 'FAIL: W42 locked';
exception when sqlstate '22023' then
  if sqlerrm not like '%paused from 2026-W41%' then raise exception 'FAIL: lock reason %', sqlerrm; end if;
end $$;
do $$
begin
  if (select count(*) from public.forecast_runs where crop_id = 'cccccccc-0000-4000-8000-00000000dc01') <> 1 then raise exception 'FAIL: runs'; end if;
end $$;

select '{"result": "post_harvest_inspections tests passed"}';
rollback;
