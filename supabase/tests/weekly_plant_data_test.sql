-- weekly_plant_data(): calculation rules, ISO weeks, year boundaries,
-- provisional week and organization isolation.
--
-- Runs inside a transaction that is always rolled back.
--   npx supabase db query --linked -f supabase/tests/weekly_plant_data_test.sql
-- Prints {"result": "weekly_plant_data tests passed"} on success.

begin;

-- ── Fixture ──────────────────────────────────────────────────────────────────
-- Org A: crop with 700 picking stems on 100 m² → 7 stems/m² exactly.
-- Org B: another organization with its own crop.
insert into auth.users (id, email, aud, role) values
  ('aaaaaaaa-0000-4000-8000-000000000001', 'wpd-test-a@example.invalid', 'authenticated', 'authenticated'),
  ('bbbbbbbb-0000-4000-8000-000000000001', 'wpd-test-b@example.invalid', 'authenticated', 'authenticated');
insert into public.organizations (id, name) values
  ('aaaaaaaa-0000-4000-8000-0000000000a0', 'WPD Org A'),
  ('bbbbbbbb-0000-4000-8000-0000000000b0', 'WPD Org B');
insert into public.organization_members (organization_id, user_id, role) values
  ('aaaaaaaa-0000-4000-8000-0000000000a0', 'aaaaaaaa-0000-4000-8000-000000000001', 'owner'),
  ('bbbbbbbb-0000-4000-8000-0000000000b0', 'bbbbbbbb-0000-4000-8000-000000000001', 'owner');
insert into public.crops (id, organization_id, name, color, planting_date, pullout_date, area_m2, picking_stems) values
  ('aaaaaaaa-0000-4000-8000-00000000c001', 'aaaaaaaa-0000-4000-8000-0000000000a0', 'Crop A', 'red', '2026-01-01', '2027-02-01', 100, 700),
  ('bbbbbbbb-0000-4000-8000-00000000c001', 'bbbbbbbb-0000-4000-8000-0000000000b0', 'Crop B', 'red', '2026-01-01', '2026-12-01', 100, 700);

insert into public.measurement_rows (id, organization_id, crop_id, row_name) values
  ('aaaaaaaa-0000-4000-8000-0000000001a1', 'aaaaaaaa-0000-4000-8000-0000000000a0', 'aaaaaaaa-0000-4000-8000-00000000c001', 'Row A'),
  ('bbbbbbbb-0000-4000-8000-0000000001b1', 'bbbbbbbb-0000-4000-8000-0000000000b0', 'bbbbbbbb-0000-4000-8000-00000000c001', 'Row B');
-- S1 is sampled from 2026-W10 to 2027-W02; S2 joins later (W12) and ends W20.
insert into public.measurement_stems (id, organization_id, crop_id, measurement_row_id, stem_name) values
  ('aaaaaaaa-0000-4000-8000-0000000002a1', 'aaaaaaaa-0000-4000-8000-0000000000a0', 'aaaaaaaa-0000-4000-8000-00000000c001', 'aaaaaaaa-0000-4000-8000-0000000001a1', 'S1'),
  ('aaaaaaaa-0000-4000-8000-0000000002a2', 'aaaaaaaa-0000-4000-8000-0000000000a0', 'aaaaaaaa-0000-4000-8000-00000000c001', 'aaaaaaaa-0000-4000-8000-0000000001a1', 'S2'),
  ('bbbbbbbb-0000-4000-8000-0000000002b1', 'bbbbbbbb-0000-4000-8000-0000000000b0', 'bbbbbbbb-0000-4000-8000-00000000c001', 'bbbbbbbb-0000-4000-8000-0000000001b1', 'S-B');

insert into public.plant_nodes (id, organization_id, crop_id, measurement_stem_id, node_number, is_side_shoot, parent_node_id, node_label, side, is_active) values
  -- N1: repeats (consecutive and after a gap) at every stage
  ('aaaaaaaa-0000-4000-8000-0000000003a1', 'aaaaaaaa-0000-4000-8000-0000000000a0', 'aaaaaaaa-0000-4000-8000-00000000c001', 'aaaaaaaa-0000-4000-8000-0000000002a1', 1, false, null, null, null, true),
  -- N2: first-ever observation is SetFruit; skips MatureGreen
  ('aaaaaaaa-0000-4000-8000-0000000003a2', 'aaaaaaaa-0000-4000-8000-0000000000a0', 'aaaaaaaa-0000-4000-8000-00000000c001', 'aaaaaaaa-0000-4000-8000-0000000002a1', 2, false, null, null, null, true),
  -- N3: mis-tap corrected in the same week; skips BreakerFruit
  ('aaaaaaaa-0000-4000-8000-0000000003a3', 'aaaaaaaa-0000-4000-8000-0000000000a0', 'aaaaaaaa-0000-4000-8000-00000000c001', 'aaaaaaaa-0000-4000-8000-0000000002a1', 3, false, null, null, null, true),
  -- N4: side shoot of N1
  ('aaaaaaaa-0000-4000-8000-0000000003a4', 'aaaaaaaa-0000-4000-8000-0000000000a0', 'aaaaaaaa-0000-4000-8000-00000000c001', 'aaaaaaaa-0000-4000-8000-0000000002a1', 1, true, 'aaaaaaaa-0000-4000-8000-0000000003a1', '1+1', 'right', true),
  -- N5: removed in the collector (inactive): ignored
  ('aaaaaaaa-0000-4000-8000-0000000003a5', 'aaaaaaaa-0000-4000-8000-0000000000a0', 'aaaaaaaa-0000-4000-8000-00000000c001', 'aaaaaaaa-0000-4000-8000-0000000002a1', 5, false, null, null, null, false),
  -- N6: set in 2026-W53, repeated in 2027-W01, breaker in 2027-W02
  ('aaaaaaaa-0000-4000-8000-0000000003a6', 'aaaaaaaa-0000-4000-8000-0000000000a0', 'aaaaaaaa-0000-4000-8000-00000000c001', 'aaaaaaaa-0000-4000-8000-0000000002a1', 6, false, null, null, null, true),
  -- M1: on S2, which has no observations in W13–W15
  ('aaaaaaaa-0000-4000-8000-0000000003b1', 'aaaaaaaa-0000-4000-8000-0000000000a0', 'aaaaaaaa-0000-4000-8000-00000000c001', 'aaaaaaaa-0000-4000-8000-0000000002a2', 1, false, null, null, null, true),
  -- Org B node
  ('bbbbbbbb-0000-4000-8000-0000000003b9', 'bbbbbbbb-0000-4000-8000-0000000000b0', 'bbbbbbbb-0000-4000-8000-00000000c001', 'bbbbbbbb-0000-4000-8000-0000000002b1', 1, false, null, null, null, true);

insert into public.node_observations (organization_id, crop_id, plant_node_id, year, week_number, status, observed_at)
select 'aaaaaaaa-0000-4000-8000-0000000000a0', 'aaaaaaaa-0000-4000-8000-00000000c001', ('aaaaaaaa-0000-4000-8000-0000000003' || n)::uuid, y, w, s, t::timestamptz
from (values
  ('a1', 2026, 10, 'Flower',       '2026-03-03 12:00Z'),
  ('a1', 2026, 11, 'SetFruit',     '2026-03-10 12:00Z'),
  ('a1', 2026, 12, 'SetFruit',     '2026-03-17 12:00Z'),
  ('a1', 2026, 14, 'SetFruit',     '2026-03-31 12:00Z'),
  ('a1', 2026, 15, 'MatureGreen',  '2026-04-07 12:00Z'),
  ('a1', 2026, 16, 'BreakerFruit', '2026-04-14 12:00Z'),
  ('a1', 2026, 17, 'BreakerFruit', '2026-04-21 12:00Z'),
  ('a1', 2026, 18, 'Harvested',    '2026-04-28 12:00Z'),
  ('a1', 2026, 19, 'Harvested',    '2026-05-05 12:00Z'),
  ('a2', 2026, 10, 'SetFruit',     '2026-03-03 12:00Z'),
  ('a2', 2026, 12, 'BreakerFruit', '2026-03-17 12:00Z'),
  ('a2', 2026, 13, 'Harvested',    '2026-03-24 12:00Z'),
  ('a3', 2026, 11, 'Flower',       '2026-03-10 12:00Z'),
  ('a3', 2026, 12, 'SetFruit',     '2026-03-17 10:00Z'),  -- mis-tap…
  ('a3', 2026, 12, 'Flower',       '2026-03-17 10:05Z'),  -- …corrected the same week
  ('a3', 2026, 13, 'SetFruit',     '2026-03-24 12:00Z'),
  ('a3', 2026, 20, 'Harvested',    '2026-05-12 12:00Z'),
  ('a4', 2026, 12, 'SetFruit',     '2026-03-17 12:00Z'),
  ('a4', 2026, 16, 'Aborted',      '2026-04-14 12:00Z'),
  ('a5', 2026, 12, 'SetFruit',     '2026-03-17 12:00Z'),
  ('a6', 2026, 53, 'SetFruit',     '2026-12-29 12:00Z'),
  ('a6', 2027,  1, 'SetFruit',     '2027-01-05 12:00Z'),
  ('a6', 2027,  2, 'BreakerFruit', '2027-01-12 12:00Z'),
  ('b1', 2026, 12, 'Flower',       '2026-03-17 12:00Z'),
  ('b1', 2026, 16, 'SetFruit',     '2026-04-14 12:00Z'),
  ('b1', 2026, 20, 'Aborted',      '2026-05-12 12:00Z')
) as v(n, y, w, s, t);
insert into public.node_observations (organization_id, crop_id, plant_node_id, year, week_number, status, observed_at) values
  ('bbbbbbbb-0000-4000-8000-0000000000b0', 'bbbbbbbb-0000-4000-8000-00000000c001', 'bbbbbbbb-0000-4000-8000-0000000003b9', 2026, 12, 'SetFruit', '2026-03-17 12:00Z');

-- ── As user A ────────────────────────────────────────────────────────────────
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-4000-8000-000000000001","role":"authenticated"}', true);

do $$
declare
  crop constant uuid := 'aaaaaaaa-0000-4000-8000-00000000c001';
  as_of constant timestamptz := '2026-10-05 03:59:00Z';  -- Sun Oct 4, 11:59 PM Toronto → 2026-W40
  got text;
  want text;
  n integer;
  sets integer;
  breakers integer;
  harvested integer;
begin
  -- 2026 has 53 ISO weeks; every week is returned, in order.
  select count(*), string_agg(iso_week::text, ',' order by iso_week) into n, got from public.weekly_plant_data(crop, 2026, as_of);
  if n <> 53 or got <> (select string_agg(g::text, ',') from generate_series(1, 53) g) then raise exception 'FAIL: expected weeks 1..53 in order, got % rows', n; end if;
  select count(*) into n from public.weekly_plant_data(crop, 2027, as_of);
  if n <> 52 then raise exception 'FAIL: 2027 should have 52 weeks, got %', n; end if;

  -- Week-by-week counts: week:stems/sets/breakers/harvested for every sampled week.
  select string_agg(format('W%s:%s/%s/%s/%s', iso_week, sampled_stems, new_sets, new_breakers, new_harvested), ' ' order by iso_week)
    into got from public.weekly_plant_data(crop, 2026, as_of) where iso_week between 10 and 21 or iso_week >= 52;
  want := 'W10:1/1/0/0 W11:1/1/0/0 W12:2/1/1/0 W13:2/1/0/1 W14:2/0/0/0 W15:2/0/0/0 W16:2/1/1/0 W17:2/0/0/0 '
       || 'W18:2/0/0/1 W19:2/0/0/0 W20:2/0/0/1 W21:1/0/0/0 W52:1/0/0/0 W53:1/1/0/0';
  -- W10  N2 first observed as SetFruit (counts)            W11  N1 Flower → SetFruit
  -- W12  N4 side shoot set; N2 breaker (skipped Mature); N3's mis-tap corrected → no set; N5 inactive ignored
  -- W13  N3 set; N2 harvested                               W14  N1 repeats SetFruit after a gap → nothing
  -- W16  M1 set; N1 breaker                                 W17  N1 repeats BreakerFruit → nothing
  -- W18  N1 harvested   W19 repeat → nothing                W20  N3 harvested (no breaker inferred)
  -- W12–W20: S2 counts as sampled, including W13–W15 when nothing was recorded on it
  -- W21–W53: S1's span runs to 2027-W02                     W53  N6 set
  if got <> want then raise exception E'FAIL: weekly counts\n got:  %\n want: %', got, want; end if;

  -- Totals: each stage once per node, nothing inferred.
  select sum(new_sets), sum(new_breakers), sum(new_harvested) into sets, breakers, harvested from public.weekly_plant_data(crop, 2026, as_of);
  if sets <> 6 or breakers <> 2 or harvested <> 3 then raise exception 'FAIL: totals sets/breakers/harvested = %/%/%', sets, breakers, harvested; end if;

  -- Unsampled weeks: no stems, null per-m² values (shown as —), never zero.
  select count(*) into n from public.weekly_plant_data(crop, 2026, as_of)
    where iso_week < 10 and (sampled_stems <> 0 or is_sampled or sampled_m2 is not null or sets_per_m2 is not null or breakers_per_m2 is not null or harvested_per_m2 is not null);
  if n <> 0 then raise exception 'FAIL: weeks before sampling must be unsampled with null rates'; end if;

  -- Sampled area uses the unrounded density: 2 stems ÷ 7 stems/m²; sets/m² = 1 ÷ (2/7) = 3.5.
  select round(sampled_m2, 6)::text || ' ' || round(sets_per_m2, 6)::text || ' ' || round(breakers_per_m2, 6)::text into got
    from public.weekly_plant_data(crop, 2026, as_of) where iso_week = 12;
  if got <> '0.285714 3.500000 3.500000' then raise exception 'FAIL: W12 area/rates = %', got; end if;
  select round(sets_per_m2, 6)::text into got from public.weekly_plant_data(crop, 2026, as_of) where iso_week = 10;
  if got <> '7.000000' then raise exception 'FAIL: W10 sets/m² = %', got; end if;

  -- Baseline: only the crop's first sampled week.
  select string_agg(iso_week::text, ',') into got from public.weekly_plant_data(crop, 2026, as_of) where is_baseline;
  if got is distinct from '10' then raise exception 'FAIL: baseline weeks = %', got; end if;
  select count(*) into n from public.weekly_plant_data(crop, 2027, as_of) where is_baseline;
  if n <> 0 then raise exception 'FAIL: 2027 has no baseline week'; end if;

  -- Year boundary: the 2027-W01 SetFruit repeats 2026-W53 and is not a new set; 2027-W02 breaker counts;
  -- S1 is sampled into 2027 until its last observation.
  select string_agg(format('W%s:%s/%s/%s', iso_week, sampled_stems, new_sets, new_breakers), ' ' order by iso_week) into got
    from public.weekly_plant_data(crop, 2027, as_of) where iso_week <= 3;
  if got <> 'W1:1/0/0 W2:1/0/1 W3:0/0/0' then raise exception 'FAIL: 2027 boundary = %', got; end if;

  -- Provisional: exactly the current greenhouse week (Toronto), which rolls over at Monday 00:00.
  select string_agg(iso_week::text, ',') into got from public.weekly_plant_data(crop, 2026, as_of) where is_provisional;
  if got is distinct from '40' then raise exception 'FAIL: provisional week (Sun 11:59 PM Toronto) = %', got; end if;
  select string_agg(iso_week::text, ',') into got from public.weekly_plant_data(crop, 2026, '2026-10-05 04:00:00Z') where is_provisional;
  if got is distinct from '41' then raise exception 'FAIL: provisional week (Mon 12:00 AM Toronto) = %', got; end if;
  select count(*) into n from public.weekly_plant_data(crop, 2025, as_of) where is_provisional;
  if n <> 0 then raise exception 'FAIL: another year has no provisional week'; end if;

  -- A crop the caller can't see (another organization's) returns nothing.
  select count(*) into n from public.weekly_plant_data('bbbbbbbb-0000-4000-8000-00000000c001', 2026, as_of);
  if n <> 0 then raise exception 'FAIL: user A read % weeks of org B''s crop', n; end if;
end $$;

-- ── As user B ────────────────────────────────────────────────────────────────
select set_config('request.jwt.claims', '{"sub":"bbbbbbbb-0000-4000-8000-000000000001","role":"authenticated"}', true);
do $$
declare n integer; s integer;
begin
  select count(*) into n from public.weekly_plant_data('aaaaaaaa-0000-4000-8000-00000000c001', 2026);
  if n <> 0 then raise exception 'FAIL: user B read % weeks of org A''s crop', n; end if;
  -- B's own crop works, and is not mixed with A's data.
  select count(*), sum(new_sets) into n, s from public.weekly_plant_data('bbbbbbbb-0000-4000-8000-00000000c001', 2026);
  if n <> 53 or s <> 1 then raise exception 'FAIL: user B own crop rows=% sets=%', n, s; end if;
end $$;

-- ── Anonymous ────────────────────────────────────────────────────────────────
select set_config('request.jwt.claims', '{"role":"anon"}', true);
set local role anon;
do $$
begin
  perform public.weekly_plant_data('aaaaaaaa-0000-4000-8000-00000000c001', 2026);
  raise exception 'FAIL: anon can call weekly_plant_data';
exception when insufficient_privilege then null;
end $$;

reset role;
select 'weekly_plant_data tests passed' as result;
rollback;
