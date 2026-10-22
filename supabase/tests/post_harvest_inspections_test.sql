-- 20261104000000_post_harvest_inspections: date-only harvests of row ranges,
-- the 14-day correction window, post-harvest inspections, harvest links and
-- the forecast-lock pause.
--
-- Dates are relative to today's greenhouse date (T), so the test holds on any
-- day. Runs inside a transaction that is always rolled back.
-- Prints {"result": "post_harvest_inspections tests passed"} on success.

begin;

-- ── Fixture ──────────────────────────────────────────────────────────────────
-- Org A: Cadalora (rows 171, 172, 319), Silverstone (row 590), Bay Crop (row
-- "Bay A", no number). Members A1 and A2 both record harvests and inspect.
--   Row 171: S1 (n1 Breaker, n2 MatureGreen, n3 SetFruit, n4 Flower),
--            S2 (n5 Breaker, n10 Breaker, n12 Breaker)
--   Row 172: S3 (n6 Breaker, n9 Breaker)
--   Row 319: S4 (n7 Breaker, later Harvested outside any inspection)
-- Harvests (T = today):
--   E0  T−10  Row 171 complete, no inspection
--   E1  T−8   Rows 160–180 complete → rows 171, 172
--   E2  T−6   Row 171 partial (the same row twice within a week)
--   E3a T−5   Row 172 complete
--   E3b T−5   Row 172 complete (a second harvest the same day)
--   Ex  T−4   Rows 400–410 + Row 319 partial, corrected, then cancelled
insert into auth.users (id, email, aud, role) values
  ('cccccccc-0000-4000-8000-00000000d001', 'ph-a1@example.invalid', 'authenticated', 'authenticated'),
  ('cccccccc-0000-4000-8000-00000000d002', 'ph-a2@example.invalid', 'authenticated', 'authenticated'),
  ('dddddddd-0000-4000-8000-00000000d003', 'ph-other@example.invalid', 'authenticated', 'authenticated');
insert into public.organizations (id, name) values
  ('cccccccc-0000-4000-8000-00000000d0a0', 'PH Org A'), ('dddddddd-0000-4000-8000-00000000d0b0', 'PH Org B');
insert into public.organization_members (organization_id, user_id, role) values
  ('cccccccc-0000-4000-8000-00000000d0a0', 'cccccccc-0000-4000-8000-00000000d001', 'owner'),
  ('cccccccc-0000-4000-8000-00000000d0a0', 'cccccccc-0000-4000-8000-00000000d002', 'member'),
  ('dddddddd-0000-4000-8000-00000000d0b0', 'dddddddd-0000-4000-8000-00000000d003', 'owner');
insert into public.crops (id, organization_id, name, color, planting_date, pullout_date, area_m2, picking_stems) values
  ('cccccccc-0000-4000-8000-00000000dc01', 'cccccccc-0000-4000-8000-00000000d0a0', 'Cadalora', 'red', '2020-01-06', '2099-12-31', 100, 700),
  ('cccccccc-0000-4000-8000-00000000dc02', 'cccccccc-0000-4000-8000-00000000d0a0', 'Silverstone', 'red', '2020-01-06', '2099-12-31', 100, 700),
  ('cccccccc-0000-4000-8000-00000000dc03', 'cccccccc-0000-4000-8000-00000000d0a0', 'Bay Crop', 'yellow', '2020-01-06', '2099-12-31', 100, 700);
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

-- Greenhouse date T + k, and that day at a Toronto wall time.
create function pg_temp.d(k integer) returns date language sql stable as $$ select public.greenhouse_today() + k $$;
create function pg_temp.at(k integer, t text) returns timestamptz language sql stable as
  $$ select (pg_temp.d(k) + t::time) at time zone 'America/Toronto' $$;
create function pg_temp.yw(day date) returns integer language sql immutable as
  $$ select extract(isoyear from day)::integer * 100 + extract(week from day)::integer $$;
create function pg_temp.node(n integer) returns uuid language sql immutable as
  $$ select ('cccccccc-0000-4000-8000-00000000d3' || lpad(n::text, 2, '0'))::uuid $$;
create function pg_temp.stem(n integer) returns uuid language sql immutable as
  $$ select ('cccccccc-0000-4000-8000-00000000d20' || n)::uuid $$;
create function pg_temp.as_user(u text) returns void language sql as
  $$ select set_config('request.jwt.claims', json_build_object('sub', u, 'role', 'authenticated')::text, true) $$;

insert into public.plant_nodes (id, organization_id, crop_id, measurement_stem_id, node_number, created_at)
select pg_temp.node(n), 'cccccccc-0000-4000-8000-00000000d0a0', 'cccccccc-0000-4000-8000-00000000dc01', pg_temp.stem(s), num, pg_temp.at(-14, '09:00')
from (values (1, 1, 1), (2, 1, 2), (3, 1, 3), (4, 1, 4), (5, 2, 1), (10, 2, 2), (12, 2, 3), (6, 3, 1), (9, 3, 2), (7, 4, 1)) x(n, s, num);

-- An observation (status, Toronto time) with its greenhouse week; returns its id.
create function pg_temp.obs(n integer, status text, ts timestamptz) returns uuid language sql as $$
  insert into public.node_observations (organization_id, crop_id, plant_node_id, year, week_number, status, observed_at)
  values ('cccccccc-0000-4000-8000-00000000d0a0', 'cccccccc-0000-4000-8000-00000000dc01', pg_temp.node(n),
          extract(isoyear from ts at time zone 'America/Toronto')::integer, extract(week from ts at time zone 'America/Toronto')::integer, status, ts)
  returning id
$$;

-- Ordinary records before the harvests (no inspection).
select pg_temp.obs(1, 'SetFruit', pg_temp.at(-13, '12:00')), pg_temp.obs(1, 'BreakerFruit', pg_temp.at(-11, '12:00')),
       pg_temp.obs(1, 'BreakerFruit', pg_temp.at(-8, '08:00')),  -- the day of E1 (order within the day unknown)
       pg_temp.obs(2, 'MatureGreen', pg_temp.at(-11, '12:00')), pg_temp.obs(3, 'SetFruit', pg_temp.at(-11, '12:00')),
       pg_temp.obs(4, 'Flower', pg_temp.at(-11, '12:00')),
       pg_temp.obs(5, 'BreakerFruit', pg_temp.at(-11, '12:00')), pg_temp.obs(5, 'BreakerFruit', pg_temp.at(-9, '10:00')),  -- after E0's day
       pg_temp.obs(6, 'BreakerFruit', pg_temp.at(-11, '12:00')), pg_temp.obs(9, 'BreakerFruit', pg_temp.at(-11, '12:00')),
       pg_temp.obs(10, 'BreakerFruit', pg_temp.at(-11, '12:00')), pg_temp.obs(7, 'BreakerFruit', pg_temp.at(-11, '12:00')),
       pg_temp.obs(12, 'BreakerFruit', pg_temp.at(-11, '12:00'));

create temp table ev (name text primary key, event_id uuid, version_id uuid, sampled_rows jsonb);
grant all on ev to authenticated;
create function pg_temp.harvest(name text, k integer, ranges text, colour numeric default 80, kg numeric default null) returns void language sql as $$
  insert into ev select name, r.event_id, r.version_id, r.sampled_rows
    from public.record_harvest_event('cccccccc-0000-4000-8000-00000000dc01', pg_temp.d(k), colour, ranges::jsonb, kg) r
$$;

set local role authenticated;
select pg_temp.as_user('cccccccc-0000-4000-8000-00000000d001');

-- ── 1. Date-only harvests, entered retrospectively (members A1 and A2) ───────
select pg_temp.harvest('E0', -10, '[{"from":171,"to":171,"coverage":"complete"}]'),
       pg_temp.harvest('E1', -8, '[{"from":160,"to":180,"coverage":"complete"}]', 85, 512.5);
select pg_temp.as_user('cccccccc-0000-4000-8000-00000000d002');  -- a member, not an owner
select pg_temp.harvest('E2', -6, '[{"from":171,"to":171,"coverage":"partial"}]', 90),
       pg_temp.harvest('E3a', -5, '[{"from":172,"to":172,"coverage":"complete"}]', 90),
       pg_temp.harvest('E3b', -5, '[{"from":172,"to":172,"coverage":"complete"}]', 90);
select pg_temp.as_user('cccccccc-0000-4000-8000-00000000d001');
insert into ev select 'Ex', r.event_id, r.version_id, r.sampled_rows from public.record_harvest_event(
  'cccccccc-0000-4000-8000-00000000dc01', pg_temp.d(-4), 80,
  '[{"from":400,"to":410,"coverage":"complete"},{"from":319,"to":319,"coverage":"partial"}]', null, 'test', null, false,
  'cccccccc-0000-4000-8000-00000000d901') r;

do $$
declare r record;
begin
  if (select sampled_rows from ev where name = 'E1') <> '[{"row_id": "cccccccc-0000-4000-8000-00000000d101", "row_name": "Row 171", "coverage": "complete", "row_number": 171},
      {"row_id": "cccccccc-0000-4000-8000-00000000d102", "row_name": "Row 172", "coverage": "complete", "row_number": 172}]'::jsonb then
    raise exception 'FAIL: E1 sampled rows %', (select sampled_rows from ev where name = 'E1');
  end if;
  if jsonb_array_length((select sampled_rows from ev where name = 'Ex')) <> 1 then raise exception 'FAIL: Ex rows'; end if;
  if (select event_id = version_id from ev where name = 'E1') is not true then raise exception 'FAIL: first version is the event'; end if;
  -- Dates only: the table has no time-of-day column; the server stamps who and when.
  if exists (select 1 from information_schema.columns where table_name = 'harvest_events' and column_name in ('finished_at', 'started_at')) then
    raise exception 'FAIL: harvests carry a time of day';
  end if;
  select * into r from public.harvest_events where id = (select version_id from ev where name = 'E2');
  if r.recorded_by <> 'cccccccc-0000-4000-8000-00000000d002' or r.recorded_at <> now() or r.harvest_date <> pg_temp.d(-6) then raise exception 'FAIL: E2 stamp %', r; end if;
  select * into r from public.harvest_events_in_effect('cccccccc-0000-4000-8000-00000000d0a0', 'cccccccc-0000-4000-8000-00000000dc01') where event_id = (select event_id from ev where name = 'E1');
  if r.editable_until <> pg_temp.d(6) or not r.editable then raise exception 'FAIL: E1 window %', r; end if;
  -- A retry with the same id returns the same version, nothing new.
  if (select x.version_id from public.record_harvest_event('cccccccc-0000-4000-8000-00000000dc01', pg_temp.d(-4), 80,
        '[{"from":400,"to":410,"coverage":"complete"}]', null, null, null, false, 'cccccccc-0000-4000-8000-00000000d901') x)
     <> 'cccccccc-0000-4000-8000-00000000d901' or (select count(*) from public.harvest_events) <> 6 then
    raise exception 'FAIL: retry';
  end if;
  if public.greenhouse_row_number('Row 171') <> 171 or public.greenhouse_row_number(' row171 ') <> 171 or public.greenhouse_row_number('R 9') <> 9
     or public.greenhouse_row_number('171') <> 171 or public.greenhouse_row_number('Bay A') is not null or public.greenhouse_row_number('Row 17 1') is not null then
    raise exception 'FAIL: greenhouse_row_number';
  end if;
end $$;

-- Rejected harvests: each must raise the given SQLSTATE with the reason.
create function pg_temp.rejects(k integer, p_colour numeric, p_ranges jsonb, p_state text, p_expect text) returns void language plpgsql as $$
begin
  perform public.record_harvest_event('cccccccc-0000-4000-8000-00000000dc01', pg_temp.d(k), p_colour, p_ranges);
  raise exception 'FAIL: accepted (%)', p_expect;
exception when others then
  if sqlstate <> p_state or sqlerrm not ilike '%' || p_expect || '%' then raise exception 'FAIL: wrong rejection for % — % %', p_expect, sqlstate, sqlerrm; end if;
end $$;
-- The window: T−14 is still open (inclusive), T−15 is not; no future dates.
select pg_temp.rejects(-15, 80, '[{"from":171,"to":171,"coverage":"complete"}]', '42501', 'only be entered or changed until');
select pg_temp.rejects(1, 80, '[{"from":171,"to":171,"coverage":"complete"}]', '22023', 'in the future');
select pg_temp.rejects(-3, 120, '[{"from":171,"to":171,"coverage":"complete"}]', '22023', 'minimum mature colour');
select pg_temp.rejects(-3, null, '[{"from":171,"to":171,"coverage":"complete"}]', '22023', 'minimum mature colour');
select pg_temp.rejects(-3, 80, '[]', '22023', 'between 1 and 20');
select pg_temp.rejects(-3, 80, '[{"from":180,"to":160,"coverage":"complete"}]', '22023', 'not a valid range');
select pg_temp.rejects(-3, 80, '[{"from":160,"to":180,"coverage":"most"}]', '22023', 'not a valid range');
select pg_temp.rejects(-3, 80, '[{"from":"abc","to":180,"coverage":"complete"}]', '22023', 'whole row numbers');
select pg_temp.rejects(-3, 80, '[{"from":160.5,"to":180,"coverage":"complete"}]', '22023', 'whole row numbers');
select pg_temp.rejects(-3, 80, '[{"from":160,"to":175,"coverage":"complete"},{"from":170,"to":180,"coverage":"partial"}]', '22023', 'overlap');
select pg_temp.rejects(-3, 80, '[{"from":580,"to":600,"coverage":"complete"}]', '22023', 'Row 590 is a sampled row of Silverstone');

do $$
declare v uuid;
begin
  -- T−14 is the last day: accepted, then cancelled again (keeps the scenario clean).
  select x.version_id into v from public.record_harvest_event('cccccccc-0000-4000-8000-00000000dc01', pg_temp.d(-14), 80, '[{"from":400,"to":400,"coverage":"complete"}]') x;
  perform public.record_harvest_event('cccccccc-0000-4000-8000-00000000dc01', null, null, null, null, 'boundary test', v, true);
  -- A variety whose sampled rows carry no number can't take ranges.
  begin
    perform public.record_harvest_event('cccccccc-0000-4000-8000-00000000dc03', pg_temp.d(-3), 80, '[{"from":1,"to":5,"coverage":"complete"}]');
    raise exception 'FAIL: unnumbered rows accepted';
  exception when sqlstate '22023' then
    if sqlerrm not like '%Bay A%' then raise exception 'FAIL: unnumbered reason %', sqlerrm; end if;
  end;
end $$;

-- ── 2. Corrections and cancellations inside the window; history kept ─────────
do $$
declare v_new uuid; r record;
begin
  -- A2 corrects Ex (kg added); A1's first version stays stored.
  perform pg_temp.as_user('cccccccc-0000-4000-8000-00000000d002');
  select x.version_id into v_new from public.record_harvest_event('cccccccc-0000-4000-8000-00000000dc01', pg_temp.d(-4), 80,
    '[{"from":400,"to":410,"coverage":"complete"}]', 120, 'kg added', 'cccccccc-0000-4000-8000-00000000d901') x;
  select * into r from public.harvest_events_in_effect('cccccccc-0000-4000-8000-00000000d0a0', 'cccccccc-0000-4000-8000-00000000dc01')
   where event_id = 'cccccccc-0000-4000-8000-00000000d901';
  if r.version_id <> v_new or r.versions <> 2 or r.harvested_kg <> 120 or r.cancelled or jsonb_array_length(r.sampled_rows) <> 0
     or r.first_recorded_by <> 'cccccccc-0000-4000-8000-00000000d001' or r.recorded_by <> 'cccccccc-0000-4000-8000-00000000d002' then
    raise exception 'FAIL: correction %', r;
  end if;
  -- Moving a harvest out of the window (to T−16) is refused.
  begin
    perform public.record_harvest_event('cccccccc-0000-4000-8000-00000000dc01', pg_temp.d(-16), 80, '[{"from":400,"to":410,"coverage":"complete"}]', 120, null, v_new);
    raise exception 'FAIL: moved out of the window';
  exception when insufficient_privilege then null;
  end;
  -- Correcting the old version again: someone else changed it.
  begin
    perform public.record_harvest_event('cccccccc-0000-4000-8000-00000000dc01', pg_temp.d(-4), 80,
      '[{"from":400,"to":410,"coverage":"complete"}]', 130, null, 'cccccccc-0000-4000-8000-00000000d901');
    raise exception 'FAIL: stale correction accepted';
  exception when sqlstate '40001' then null;
  end;
  -- Cancelling needs a reason, then keeps the harvest's data.
  begin
    perform public.record_harvest_event('cccccccc-0000-4000-8000-00000000dc01', null, null, null, null, ' ', v_new, true);
    raise exception 'FAIL: cancel without reason';
  exception when sqlstate '22023' then null;
  end;
  perform pg_temp.as_user('cccccccc-0000-4000-8000-00000000d001');
  perform public.record_harvest_event('cccccccc-0000-4000-8000-00000000dc01', null, null, null, null, 'Entered twice', v_new, true);
  select * into r from public.harvest_events_in_effect('cccccccc-0000-4000-8000-00000000d0a0', 'cccccccc-0000-4000-8000-00000000dc01')
   where event_id = 'cccccccc-0000-4000-8000-00000000d901';
  if not r.cancelled or r.editable or r.versions <> 3 or r.harvested_kg <> 120 or r.harvest_date <> pg_temp.d(-4) or r.note <> 'Entered twice' then
    raise exception 'FAIL: cancel %', r;
  end if;
  begin
    perform public.record_harvest_event('cccccccc-0000-4000-8000-00000000dc01', pg_temp.d(-4), 80,
      '[{"from":400,"to":410,"coverage":"complete"}]', null, null, r.version_id);
    raise exception 'FAIL: cancelled harvest changed';
  exception when sqlstate '22023' then null;
  end;
  -- The full history in order (each version replaces the previous): author, kg, cancelled, ranges stored.
  if (with recursive chain(id, n) as (
        select e.id, 1 from public.harvest_events e where e.id = 'cccccccc-0000-4000-8000-00000000d901'
        union all select e.id, c.n + 1 from public.harvest_events e join chain c on e.replaces_id = c.id)
      select string_agg(format('%s:%s:%s:%s', right(e.recorded_by::text, 1), coalesce(e.harvested_kg::text, '-'), e.cancelled,
                               (select count(*) from public.harvest_event_ranges g where g.harvest_event_version_id = e.id)), ' ' order by c.n)
        from chain c join public.harvest_events e on e.id = c.id)
     <> '1:-:f:2 2:120.00:f:1 1:120.00:t:1' then
    raise exception 'FAIL: history %', (with recursive chain(id, n) as (
        select e.id, 1 from public.harvest_events e where e.id = 'cccccccc-0000-4000-8000-00000000d901'
        union all select e.id, c.n + 1 from public.harvest_events e join chain c on e.replaces_id = c.id)
      select string_agg(format('%s:%s:%s:%s', right(e.recorded_by::text, 1), coalesce(e.harvested_kg::text, '-'), e.cancelled,
                               (select count(*) from public.harvest_event_ranges g where g.harvest_event_version_id = e.id)), ' ' order by c.n)
        from chain c join public.harvest_events e on e.id = c.id);
  end if;
end $$;

-- ── 3. A harvest older than 14 days is read-only for everyone ────────────────
-- Stored as it would be if it had been entered in time (triggers skipped only to build the fixture).
reset role;
set local session_replication_role = replica;
insert into public.harvest_events (id, event_id, organization_id, crop_id, harvest_date, min_colour_percent, recorded_at, recorded_by)
values ('cccccccc-0000-4000-8000-00000000d9a0', 'cccccccc-0000-4000-8000-00000000d9a0', 'cccccccc-0000-4000-8000-00000000d0a0',
        'cccccccc-0000-4000-8000-00000000dc01', pg_temp.d(-20), 80, now() - interval '20 days', 'cccccccc-0000-4000-8000-00000000d001');
insert into public.harvest_event_ranges (harvest_event_version_id, organization_id, position, from_row, to_row, coverage)
values ('cccccccc-0000-4000-8000-00000000d9a0', 'cccccccc-0000-4000-8000-00000000d0a0', 1, 500, 510, 'complete');
set local session_replication_role = origin;

set local role authenticated;
select pg_temp.as_user('cccccccc-0000-4000-8000-00000000d001');
do $$
begin
  if (select editable from public.harvest_events_in_effect('cccccccc-0000-4000-8000-00000000d0a0', 'cccccccc-0000-4000-8000-00000000dc01')
       where event_id = 'cccccccc-0000-4000-8000-00000000d9a0') then
    raise exception 'FAIL: old harvest shown editable';
  end if;
  -- Moving the locked harvest into the window, correcting it in place, or cancelling it: all refused.
  begin
    perform public.record_harvest_event('cccccccc-0000-4000-8000-00000000dc01', pg_temp.d(-3), 80, '[{"from":500,"to":510,"coverage":"complete"}]', null, null, 'cccccccc-0000-4000-8000-00000000d9a0');
    raise exception 'FAIL: locked harvest moved into the window';
  exception when insufficient_privilege then
    if sqlerrm not like '%is locked%' then raise exception 'FAIL: lock reason %', sqlerrm; end if;
  end;
  begin
    perform public.record_harvest_event('cccccccc-0000-4000-8000-00000000dc01', pg_temp.d(-20), 70, '[{"from":500,"to":510,"coverage":"complete"}]', null, null, 'cccccccc-0000-4000-8000-00000000d9a0');
    raise exception 'FAIL: locked harvest corrected';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.record_harvest_event('cccccccc-0000-4000-8000-00000000dc01', null, null, null, null, 'late cancel', 'cccccccc-0000-4000-8000-00000000d9a0', true);
    raise exception 'FAIL: locked harvest cancelled';
  exception when insufficient_privilege then null;
  end;
  -- Direct writes as a member: no privilege on the tables at all.
  begin
    insert into public.harvest_events (id, event_id, organization_id, crop_id, harvest_date, min_colour_percent, replaces_id, recorded_by)
      values (gen_random_uuid(), 'cccccccc-0000-4000-8000-00000000d9a0', 'cccccccc-0000-4000-8000-00000000d0a0', 'cccccccc-0000-4000-8000-00000000dc01',
              pg_temp.d(-3), 80, 'cccccccc-0000-4000-8000-00000000d9a0', auth.uid());
    raise exception 'FAIL: direct insert';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.harvest_event_ranges (harvest_event_version_id, organization_id, position, from_row, to_row, coverage)
      values ('cccccccc-0000-4000-8000-00000000d9a0', 'cccccccc-0000-4000-8000-00000000d0a0', 2, 520, 530, 'complete');
    raise exception 'FAIL: direct range insert';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.harvest_events set harvest_date = pg_temp.d(-3);
    raise exception 'FAIL: update';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

-- Even the table owner (as the API's service role would) can't get round the window,
-- add ranges to an existing version, rewrite or delete history.
do $$
begin
  -- No signed-in member: refused.
  perform set_config('request.jwt.claims', '{}', true);
  begin
    insert into public.harvest_events (id, event_id, organization_id, crop_id, harvest_date, min_colour_percent, recorded_by)
      values ('cccccccc-0000-4000-8000-00000000d9b0', 'cccccccc-0000-4000-8000-00000000d9b0', 'cccccccc-0000-4000-8000-00000000d0a0', 'cccccccc-0000-4000-8000-00000000dc01',
              pg_temp.d(-3), 80, 'cccccccc-0000-4000-8000-00000000d001');
    raise exception 'FAIL: insert without a member';
  exception when insufficient_privilege then null;
  end;
  -- In a member's name: still the window, for the new date and for the replaced one.
  perform pg_temp.as_user('cccccccc-0000-4000-8000-00000000d001');
  begin
    insert into public.harvest_events (id, event_id, organization_id, crop_id, harvest_date, min_colour_percent, recorded_by)
      values ('cccccccc-0000-4000-8000-00000000d9b1', 'cccccccc-0000-4000-8000-00000000d9b1', 'cccccccc-0000-4000-8000-00000000d0a0', 'cccccccc-0000-4000-8000-00000000dc01',
              pg_temp.d(-15), 80, 'cccccccc-0000-4000-8000-00000000d001');
    raise exception 'FAIL: owner inserted a harvest outside the window';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.harvest_events (id, event_id, organization_id, crop_id, harvest_date, min_colour_percent, replaces_id, recorded_by)
      values ('cccccccc-0000-4000-8000-00000000d9b2', 'cccccccc-0000-4000-8000-00000000d9a0', 'cccccccc-0000-4000-8000-00000000d0a0', 'cccccccc-0000-4000-8000-00000000dc01',
              pg_temp.d(-3), 80, 'cccccccc-0000-4000-8000-00000000d9a0', 'cccccccc-0000-4000-8000-00000000d001');
    raise exception 'FAIL: owner moved a locked harvest';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.harvest_event_ranges (harvest_event_version_id, organization_id, position, from_row, to_row, coverage)
      values ('cccccccc-0000-4000-8000-00000000d9a0', 'cccccccc-0000-4000-8000-00000000d0a0', 2, 520, 530, 'complete');
    raise exception 'FAIL: owner added a range to a stored version';
  exception when insufficient_privilege then null;
  end;
  begin
    delete from public.harvest_event_ranges;
    raise exception 'FAIL: ranges deleted';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.harvest_events set recorded_by = 'cccccccc-0000-4000-8000-00000000d002';
    raise exception 'FAIL: history rewritten';
  exception when insufficient_privilege then null;
  end;
end $$;

set local role authenticated;

-- ── 4. Inspections (member A2) ───────────────────────────────────────────────
select pg_temp.as_user('cccccccc-0000-4000-8000-00000000d002');

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

-- A check dated before the harvest doesn't belong to its inspection (S3, a day before E1).
select pg_temp.check_stem(3, pg_temp.at(-9, '12:00'), 'E1');

-- E1 (T−8).
select pg_temp.answer(1, 'Harvested', pg_temp.at(-8, '15:00'), 'E1'),
       pg_temp.answer(2, 'MatureGreen', pg_temp.at(-8, '15:01'), 'E1');
-- Not complete yet: n3 is unanswered, so "all fruit checked" doesn't make it complete.
select pg_temp.check_stem(1, pg_temp.at(-8, '15:02'), 'E1');
do $$
declare r record;
begin
  select * into r from public.post_harvest_inspection_stems('cccccccc-0000-4000-8000-00000000dc01')
   where event_id = (select event_id from ev where name = 'E1') and measurement_stem_id = pg_temp.stem(1);
  if r.state <> 'in_progress' or r.to_confirm <> 3 or r.answered <> 2 or r.unanswered <> 1 then raise exception 'FAIL: S1 partly answered %', r; end if;
end $$;
select pg_temp.answer(3, 'SetFruit', pg_temp.at(-8, '15:03'), 'E1'),
       pg_temp.new_node(8, 1, 5, pg_temp.at(-8, '15:04')), pg_temp.answer(8, 'SetFruit', pg_temp.at(-8, '15:04'), 'E1'),
       pg_temp.new_node(11, 1, 6, pg_temp.at(-8, '15:05')), pg_temp.answer(11, 'Harvested', pg_temp.at(-8, '15:05'), 'E1'),
       pg_temp.check_stem(1, pg_temp.at(-8, '15:06'), 'E1');
select pg_temp.answer(5, 'Harvested', pg_temp.at(-8, '15:10'), 'E1'),
       pg_temp.answer(10, 'Harvested', pg_temp.at(-8, '15:11'), 'E1'),
       pg_temp.answer(12, 'BreakerFruit', pg_temp.at(-8, '15:12'), 'E1'),  -- still there after E1
       pg_temp.check_stem(2, pg_temp.at(-8, '15:13'), 'E1');
select pg_temp.answer(6, 'Harvested', pg_temp.at(-8, '15:20'), 'E1');  -- S3: n9 never answered, and only the early check
-- n12: seen again on an ordinary visit the next day, then recorded Harvested as a late answer to E1.
select pg_temp.obs(12, 'BreakerFruit', pg_temp.at(-7, '12:00')), pg_temp.answer(12, 'Harvested', pg_temp.at(-7, '12:05'), 'E1');

-- E2 (T−6, row 171 partly harvested): the same stems inspected again.
select pg_temp.answer(2, 'Harvested', pg_temp.at(-6, '12:00'), 'E2'),
       pg_temp.answer(3, 'SetFruit', pg_temp.at(-6, '12:01'), 'E2'),
       pg_temp.answer(8, 'MatureGreen', pg_temp.at(-6, '12:02'), 'E2'),
       pg_temp.check_stem(1, pg_temp.at(-6, '12:03'), 'E2'),
       pg_temp.check_stem(2, pg_temp.at(-6, '12:10'), 'E2');

-- E3a (T−5), checked the same day as the second harvest of that row (E3b).
select pg_temp.answer(9, 'Harvested', pg_temp.at(-5, '16:50'), 'E3a'),
       pg_temp.check_stem(3, pg_temp.at(-5, '17:00'), 'E3a');

-- n7 (row 319) recorded Harvested on an ordinary visit.
select pg_temp.obs(7, 'Harvested', pg_temp.at(-3, '12:00'));

do $$
declare got text;
begin
  select string_agg(format('%s/%s:%s %s/%s/%s new%s h%s%s', e.name, s.stem_name, s.state, s.to_confirm, s.answered, s.unanswered, s.new_nodes, s.harvested,
                           case when s.later_harvest then ' later' else '' end), ' | ' order by e.name, s.stem_name)
    into got
    from public.post_harvest_inspection_stems('cccccccc-0000-4000-8000-00000000dc01') s join ev e on e.event_id = s.event_id;
  -- An inspection without a completed check lists what is on the plant now (E0/S1: n3, n8); every
  -- harvest of the row dated from it up to its check (or today) counts against it.
  if got <> 'E0/S1:not_started 2/0/2 new0 h0 later | E0/S2:not_started 0/0/0 new0 h0 later | '
          || 'E1/S1:complete 3/3/0 new2 h2 | E1/S2:complete 3/3/0 new0 h3 | E1/S3:in_progress 1/1/0 new0 h1 later | '
          || 'E2/S1:complete 3/3/0 new0 h1 | E2/S2:complete 0/0/0 new0 h0 | '
          || 'E3a/S3:complete 1/1/0 new0 h1 later | E3b/S3:not_started 0/0/0 new0 h0 later' then
    raise exception 'FAIL: inspection progress %', got;
  end if;
  -- S3's check dated the day before E1 isn't part of E1's inspection.
  if (select checked_at from public.post_harvest_inspection_stems('cccccccc-0000-4000-8000-00000000dc01')
       where event_id = (select event_id from ev where name = 'E1') and measurement_stem_id = pg_temp.stem(3)) is not null then
    raise exception 'FAIL: early check counted';
  end if;
  -- An inspection check counts as the week's ordinary stem visit too.
  if not exists (select 1 from public.crop_stem_weeks('cccccccc-0000-4000-8000-00000000dc01') w
                  where w.measurement_stem_id = pg_temp.stem(2) and w.yw = pg_temp.yw(pg_temp.d(-8)) and w.visited) then
    raise exception 'FAIL: inspection check is not a visit';
  end if;
end $$;

-- ── 5. Harvest links from calendar dates ─────────────────────────────────────
create function pg_temp.links() returns text language sql as $$
  select string_agg(format('n%s:%s%s', right(l.plant_node_id::text, 2)::integer, l.link_status,
                           coalesce('@T' || (l.harvest_date - public.greenhouse_today()), '')
                           || coalesce('[' || (select string_agg(e.name, ',' order by e.name) from ev e where e.event_id = any (l.candidate_event_ids)) || ']', '')),
                    ' ' order by right(l.plant_node_id::text, 2)::integer)
    from public.fruit_harvest_links('cccccccc-0000-4000-8000-00000000dc01') l
$$;
do $$
declare got text := pg_temp.links();
begin
  -- n1: seen on E1's day, harvested in E1's inspection: E1 (the only harvest of the row that day).
  -- n2: still there after E1 (its answer), harvested in E2's inspection: only E2, but the row was partly harvested.
  -- n5: seen the day after E0: only E1.   n10: last seen before E0: E0 or E1.
  -- n12: seen the day after E1, then recorded harvested for E1: E1 can't have taken it.
  if got <> 'n1:inferred@T-8[E1] n2:partial_row[E2] n5:inferred@T-8[E1] n6:inspection_incomplete[E1] '
          || 'n7:not_from_inspection n9:later_harvest[E1,E3a,E3b] n10:several_possible[E0,E1] n11:no_earlier_record[E0,E1] n12:no_matching_harvest' then
    raise exception 'FAIL: links %', got;
  end if;
end $$;

-- Reviews (any member): confirm n10 in E0, reject n1, then reopen n1.
do $$
begin
  insert into public.harvest_link_reviews (organization_id, crop_id, node_observation_id, decision, harvest_event_id, note)
  select 'cccccccc-0000-4000-8000-00000000d0a0', 'cccccccc-0000-4000-8000-00000000dc01', l.node_observation_id, 'confirmed', (select event_id from ev where name = 'E0'), 'Picker confirmed'
    from public.fruit_harvest_links('cccccccc-0000-4000-8000-00000000dc01') l where l.plant_node_id = pg_temp.node(10);
  insert into public.harvest_link_reviews (organization_id, crop_id, node_observation_id, decision, note)
  select 'cccccccc-0000-4000-8000-00000000d0a0', 'cccccccc-0000-4000-8000-00000000dc01', l.node_observation_id, 'rejected', 'Dropped, not picked'
    from public.fruit_harvest_links('cccccccc-0000-4000-8000-00000000dc01') l where l.plant_node_id = pg_temp.node(1);
  if pg_temp.links() not like 'n1:rejected[E1] %n10:confirmed@T-10[E0,E1] %' then raise exception 'FAIL: reviewed %', pg_temp.links(); end if;
  insert into public.harvest_link_reviews (organization_id, crop_id, node_observation_id, decision)
  select 'cccccccc-0000-4000-8000-00000000d0a0', 'cccccccc-0000-4000-8000-00000000dc01', l.node_observation_id, 'unreviewed'
    from public.fruit_harvest_links('cccccccc-0000-4000-8000-00000000dc01') l where l.plant_node_id = pg_temp.node(1);
  if pg_temp.links() not like 'n1:inferred@T-8[E1] %' then raise exception 'FAIL: reopened %', pg_temp.links(); end if;
  if (select count(*) from public.harvest_link_reviews) <> 3 then raise exception 'FAIL: review history'; end if;
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
    values ('cccccccc-0000-4000-8000-00000000d0a0', 'cccccccc-0000-4000-8000-00000000dc01', pg_temp.stem(1), pg_temp.yw(pg_temp.d(0)) / 100, pg_temp.yw(pg_temp.d(0)) % 100, now(),
            (select version_id from public.harvest_events_in_effect('cccccccc-0000-4000-8000-00000000d0a0', 'cccccccc-0000-4000-8000-00000000dc01')
              where event_id = 'cccccccc-0000-4000-8000-00000000d901'), true);
    raise exception 'FAIL: check names a later version, not the harvest';
  exception when sqlstate '23514' then null;
  end;
  begin
    insert into public.stem_visits (organization_id, crop_id, measurement_stem_id, year, week_number, observed_at, harvest_event_id)
    values ('cccccccc-0000-4000-8000-00000000d0a0', 'cccccccc-0000-4000-8000-00000000dc01', pg_temp.stem(1), pg_temp.yw(pg_temp.d(0)) / 100, pg_temp.yw(pg_temp.d(0)) % 100, now(),
            (select event_id from ev where name = 'E1'));
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
  values ('cccccccc-0000-4000-8000-00000000d0a0', 'cccccccc-0000-4000-8000-00000000dc01', pg_temp.stem(4), pg_temp.yw(pg_temp.d(-3)) / 100, pg_temp.yw(pg_temp.d(-3)) % 100, pg_temp.at(-3, '12:05'));
end $$;

-- ── 6. Inventory: each stem's latest records, whatever day ───────────────────
do $$
declare got text;
begin
  select string_agg(format('%s:%s/%s/%s%s', i.stem_name, i.set_fruit, i.mature_green, i.breakers,
                           coalesce(' ' || (select e.name from ev e where e.event_id = i.last_inspection_event_id), '')), ' ' order by i.stem_name)
    into got from public.stem_inventory_latest('cccccccc-0000-4000-8000-00000000dc01') i;
  if got <> 'S1:1/1/0 E2 S2:0/0/0 E2 S3:0/0/0 E3a S4:0/0/0' then raise exception 'FAIL: inventory %', got; end if;
end $$;

-- ── 7. Another organization and anon ─────────────────────────────────────────
select pg_temp.as_user('dddddddd-0000-4000-8000-00000000d003');
do $$
begin
  if exists (select 1 from public.harvest_events) or exists (select 1 from public.harvest_inspection_answers)
     or exists (select 1 from public.harvest_events_in_effect('cccccccc-0000-4000-8000-00000000d0a0'))
     or exists (select 1 from public.fruit_harvest_links('cccccccc-0000-4000-8000-00000000dc01')) then
    raise exception 'FAIL: B sees A''s harvests';
  end if;
  begin
    perform public.record_harvest_event('cccccccc-0000-4000-8000-00000000dc01', pg_temp.d(-3), 80, '[{"from":171,"to":171,"coverage":"complete"}]');
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

-- ── 8. Forecast locking paused from the first post-harvest week ─────────────
-- Cadalora's first harvest is the locked one of T−20 (section 3). Silverstone has none.
create temp table weeks as
  select pg_temp.yw(pg_temp.d(-20)) as from_yw, pg_temp.yw(pg_temp.d(-27)) as before_yw, pg_temp.yw(pg_temp.d(-3)) as during_yw;
do $$
declare j record; w record;
begin
  select * into w from weeks;
  if public.post_harvest_workflow_from('cccccccc-0000-4000-8000-00000000dc01') <> w.from_yw
     or public.post_harvest_workflow_from('cccccccc-0000-4000-8000-00000000dc02') is not null then
    raise exception 'FAIL: workflow start %', public.post_harvest_workflow_from('cccccccc-0000-4000-8000-00000000dc01');
  end if;
  insert into public.sampling_week_events (id, organization_id, crop_id, year, week_number, event, observed_at) values
    ('cccccccc-0000-4000-8000-00000000d940', 'cccccccc-0000-4000-8000-00000000d0a0', 'cccccccc-0000-4000-8000-00000000dc01', w.before_yw / 100, w.before_yw % 100, 'completed', pg_temp.at(-27, '15:00')),
    ('cccccccc-0000-4000-8000-00000000d942', 'cccccccc-0000-4000-8000-00000000d0a0', 'cccccccc-0000-4000-8000-00000000dc01', w.during_yw / 100, w.during_yw % 100, 'completed', pg_temp.at(-3, '15:00')),
    ('cccccccc-0000-4000-8000-00000000d952', 'cccccccc-0000-4000-8000-00000000d0a0', 'cccccccc-0000-4000-8000-00000000dc02', w.during_yw / 100, w.during_yw % 100, 'completed', pg_temp.at(-3, '15:00'));
  select * into j from public.forecast_lock_jobs where sampling_event_id = 'cccccccc-0000-4000-8000-00000000d942';
  if j.status <> 'paused' or j.last_error not like format('%%paused from %s-W%s%%', w.from_yw / 100, lpad((w.from_yw % 100)::text, 2, '0')) then raise exception 'FAIL: paused job %', j; end if;
  if (select status from public.forecast_lock_jobs where sampling_event_id = 'cccccccc-0000-4000-8000-00000000d940') <> 'pending'
     or (select status from public.forecast_lock_jobs where sampling_event_id = 'cccccccc-0000-4000-8000-00000000d952') <> 'pending' then
    raise exception 'FAIL: earlier week / other variety not pending';
  end if;
end $$;

create function pg_temp.lock_run(yw integer, event uuid) returns void language sql as $$
  insert into public.forecast_runs (id, organization_id, crop_id, origin_year, origin_week, kind, sampling_event_id, observed_cutoff, recorded_cutoff,
                                    first_target_starts, horizon, marketing_weeks, engine_version, confidence, model, data_summary, sample_stems,
                                    sample_stem_ids, scale, marketing_sample_fruit, marketing_crop_fruit)
  values (gen_random_uuid(), 'cccccccc-0000-4000-8000-00000000d0a0', 'cccccccc-0000-4000-8000-00000000dc01', yw / 100, yw % 100, 'official', event, now(), now(),
          now(), 1, 1, 'test', 'experimental', '{}', '{}', 0, '{}', 0, 0, 0)
$$;
-- A week before the new workflow still locks; a week in it doesn't.
select pg_temp.lock_run((select before_yw from weeks), 'cccccccc-0000-4000-8000-00000000d940');
do $$
begin
  perform pg_temp.lock_run((select during_yw from weeks), 'cccccccc-0000-4000-8000-00000000d942');
  raise exception 'FAIL: post-harvest week locked';
exception when sqlstate '22023' then
  if sqlerrm not like '%paused from%' then raise exception 'FAIL: lock reason %', sqlerrm; end if;
end $$;
do $$
begin
  if (select count(*) from public.forecast_runs where crop_id = 'cccccccc-0000-4000-8000-00000000dc01') <> 1 then raise exception 'FAIL: runs'; end if;
end $$;

select '{"result": "post_harvest_inspections tests passed"}';
rollback;
