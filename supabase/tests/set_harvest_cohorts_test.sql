-- set_harvest_cohorts(): +0 → +10 cohort ladder (a first Harvested record at
-- +1 … +10 counts; +11 or later is outside the window), Timeout / Aborted /
-- Pruned losses, closing-cohort Loss, reconciliation with weekly_plant_data(),
-- ISO-year boundaries, in-progress week and organization isolation.
--
-- Runs inside a transaction that is always rolled back.
--   npx supabase db query --linked -f supabase/tests/set_harvest_cohorts_test.sql
-- Prints {"result": "set_harvest_cohorts tests passed"} on success.

begin;

-- ── Reconciliation over every crop already in the database ──────────────────
-- Raw Harvested (weekly_plant_data) = harvested within cohort windows
-- + harvested with no SetFruit + harvested after the +10 window, every week.
do $$
declare r record;
begin
  for r in
    select c.id as crop_id, c.name, y.year
    from public.crops c
    join lateral (select distinct o.year from public.node_observations o where o.crop_id = c.id) y on true
  loop
    perform 1
    from public.set_harvest_cohorts(r.crop_id, r.year) h
    join public.weekly_plant_data(r.crop_id, r.year) w using (iso_week)
    where h.harvested_total <> w.new_harvested
       or h.harvested_total <> h.harvested_in_window + h.harvested_without_set + h.harvested_after_timeout
       or h.harvested_in_window <> (select coalesce(sum((c->>'harvested')::int), 0) from jsonb_array_elements(h.cells) c)
       or jsonb_array_length(h.cells) <> 11;
    if found then raise exception 'FAIL: cohort harvests do not reconcile for crop % (%), year %', r.name, r.crop_id, r.year; end if;
    -- Every cohort's outcomes add up to its sets; a closed cohort has nothing left on the plant.
    perform 1
    from public.set_harvest_cohorts(r.crop_id, r.year) h, jsonb_array_elements(h.cells) c
    where (c->>'cohort_harvested')::int + (c->>'cohort_aborted')::int + (c->>'cohort_pruned')::int
          + (c->>'cohort_timeout')::int + (c->>'cohort_on_plant')::int <> (c->>'cohort_sets')::int
       or ((c->>'cohort_closed')::boolean and (c->>'cohort_on_plant')::int <> 0)
       or (not (c->>'cohort_closed')::boolean and (c->>'cohort_timeout')::int <> 0);
    if found then raise exception 'FAIL: cohort outcomes inconsistent for crop % (%), year %', r.name, r.crop_id, r.year; end if;
  end loop;
end $$;

-- ── Fixture ──────────────────────────────────────────────────────────────────
insert into auth.users (id, email, aud, role) values
  ('aaaaaaaa-0000-4000-8000-000000000001', 'shc-test-a@example.invalid', 'authenticated', 'authenticated'),
  ('bbbbbbbb-0000-4000-8000-000000000001', 'shc-test-b@example.invalid', 'authenticated', 'authenticated');
insert into public.organizations (id, name) values
  ('aaaaaaaa-0000-4000-8000-0000000000a0', 'SHC Org A'),
  ('bbbbbbbb-0000-4000-8000-0000000000b0', 'SHC Org B');
insert into public.organization_members (organization_id, user_id, role) values
  ('aaaaaaaa-0000-4000-8000-0000000000a0', 'aaaaaaaa-0000-4000-8000-000000000001', 'owner'),
  ('bbbbbbbb-0000-4000-8000-0000000000b0', 'bbbbbbbb-0000-4000-8000-000000000001', 'owner');
insert into public.crops (id, organization_id, name, color, planting_date, pullout_date, area_m2, picking_stems) values
  ('aaaaaaaa-0000-4000-8000-00000000c001', 'aaaaaaaa-0000-4000-8000-0000000000a0', 'Crop A', 'red', '2026-01-01', '2027-03-01', 100, 700),
  ('bbbbbbbb-0000-4000-8000-00000000c001', 'bbbbbbbb-0000-4000-8000-0000000000b0', 'Crop B', 'red', '2026-01-01', '2026-12-01', 100, 700);
insert into public.measurement_rows (id, organization_id, crop_id, row_name) values
  ('aaaaaaaa-0000-4000-8000-0000000001a1', 'aaaaaaaa-0000-4000-8000-0000000000a0', 'aaaaaaaa-0000-4000-8000-00000000c001', 'Row A'),
  ('bbbbbbbb-0000-4000-8000-0000000001b1', 'bbbbbbbb-0000-4000-8000-0000000000b0', 'bbbbbbbb-0000-4000-8000-00000000c001', 'Row B');
-- S1: sampled 2026-W10 … 2027-W03 (W10 is the crop's baseline). S2: W12 … W22.
insert into public.measurement_stems (id, organization_id, crop_id, measurement_row_id, stem_name) values
  ('aaaaaaaa-0000-4000-8000-0000000002a1', 'aaaaaaaa-0000-4000-8000-0000000000a0', 'aaaaaaaa-0000-4000-8000-00000000c001', 'aaaaaaaa-0000-4000-8000-0000000001a1', 'S1'),
  ('aaaaaaaa-0000-4000-8000-0000000002a2', 'aaaaaaaa-0000-4000-8000-0000000000a0', 'aaaaaaaa-0000-4000-8000-00000000c001', 'aaaaaaaa-0000-4000-8000-0000000001a1', 'S2'),
  ('bbbbbbbb-0000-4000-8000-0000000002b1', 'bbbbbbbb-0000-4000-8000-0000000000b0', 'bbbbbbbb-0000-4000-8000-00000000c001', 'bbbbbbbb-0000-4000-8000-0000000001b1', 'S-B');

insert into public.plant_nodes (id, organization_id, crop_id, measurement_stem_id, node_number, is_side_shoot, parent_node_id, node_label, side, is_active)
select ('aaaaaaaa-0000-4000-8000-0000000003' || id)::uuid, 'aaaaaaaa-0000-4000-8000-0000000000a0', 'aaaaaaaa-0000-4000-8000-00000000c001',
       ('aaaaaaaa-0000-4000-8000-0000000002' || stem)::uuid, num, shoot, case when shoot then 'aaaaaaaa-0000-4000-8000-0000000003a4'::uuid end,
       case when shoot then '4+1' end, case when shoot then 'right' end, active
from (values
  -- cohort W10 (baseline): 3 sets
  ('a1', 'a1', 1, false, true),   -- W10 set → W16 harvested (+6)
  ('a2', 'a1', 2, false, true),   -- W10 set, repeated W11 → W17 harvested (+7), repeated W18
  ('a3', 'a1', 3, false, true),   -- W10 set → W12 Aborted
  -- cohort W11: 3 sets
  ('a4', 'a1', 4, false, true),   -- W10 Flower, W11 set → W15 harvested (+4)
  ('a5', 'a1', 5, false, true),   -- W11 set → W13 Pruned
  ('a6', 'a1', 6, false, true),   -- W11 set → W14 MatureGreen, then nothing: Timeout once W21 (+10) closes
  -- cohort W12: 3 sets
  ('a7', 'a1', 7, false, true),   -- W11 set mis-tap corrected to Flower; W12 set → W20 harvested (+8), no breaker
  ('a8', 'a1', 4, true,  true),   -- side shoot: W12 set → W18 harvested (+6)
  ('b1', 'a2', 1, false, true),   -- S2: W12 set → W22 harvested (+10, the last valid age)
  -- cohort W13: 3 sets
  ('aa', 'a1', 10, false, true),  -- W13 set; W19 Harvested corrected the same week; W20 harvested (+7)
  ('a0', 'a1', 17, false, true),  -- W13 set → W25 harvested (+12): outside the window → Timeout
  ('c1', 'a1', 18, false, true),  -- W13 set → W27 harvested (+14): outside the window → Timeout
  -- cohort W14: 2 sets
  ('ad', 'a1', 13, false, true),  -- W14 set → W25 harvested (+11): outside the window → Timeout
  ('ae', 'a1', 14, false, true),  -- W14 set → W27 harvested (+13): Timeout for the cohort, still raw Harvested
  -- cohort W35 (open on 2026-W40): 2 sets
  ('af', 'a1', 15, false, true),  -- W35 set → W37 MatureGreen: still on the plant
  ('bb', 'a1', 16, false, true),  -- W35 set → W36 Aborted: lost so far
  -- cohort 2026-W52: 1 set
  ('ab', 'a1', 11, false, true),  -- 2026-W52 set → 2027-W03 harvested (+4 across the year boundary; 2026 has W53)
  -- no cohort
  ('a9', 'a1', 9, false, true),   -- never SetFruit: W16 harvested
  ('ac', 'a1', 12, false, false)  -- removed in the collector: ignored
) as v(id, stem, num, shoot, active);
insert into public.plant_nodes (id, organization_id, crop_id, measurement_stem_id, node_number) values
  ('bbbbbbbb-0000-4000-8000-0000000003b9', 'bbbbbbbb-0000-4000-8000-0000000000b0', 'bbbbbbbb-0000-4000-8000-00000000c001', 'bbbbbbbb-0000-4000-8000-0000000002b1', 1);

insert into public.node_observations (organization_id, crop_id, plant_node_id, year, week_number, status, observed_at)
select 'aaaaaaaa-0000-4000-8000-0000000000a0', 'aaaaaaaa-0000-4000-8000-00000000c001', ('aaaaaaaa-0000-4000-8000-0000000003' || n)::uuid,
       y, w, s, to_date(y || '-' || lpad(w::text, 2, '0'), 'IYYY-IW') + interval '1 day' + t::interval
from (values
  ('a1', 2026, 10, 'SetFruit', '12:00'), ('a1', 2026, 16, 'Harvested', '12:00'),
  ('a2', 2026, 10, 'SetFruit', '12:00'), ('a2', 2026, 11, 'SetFruit', '12:00'), ('a2', 2026, 17, 'Harvested', '12:00'), ('a2', 2026, 18, 'Harvested', '12:00'),
  ('a3', 2026, 10, 'SetFruit', '12:00'), ('a3', 2026, 12, 'Aborted', '12:00'),
  ('a4', 2026, 10, 'Flower', '12:00'),   ('a4', 2026, 11, 'SetFruit', '12:00'), ('a4', 2026, 15, 'Harvested', '12:00'),
  ('a5', 2026, 11, 'SetFruit', '12:00'), ('a5', 2026, 13, 'Pruned', '12:00'),
  ('a6', 2026, 11, 'SetFruit', '12:00'), ('a6', 2026, 14, 'MatureGreen', '12:00'),
  ('a7', 2026, 11, 'SetFruit', '10:00'), ('a7', 2026, 11, 'Flower', '10:05'), ('a7', 2026, 12, 'SetFruit', '12:00'), ('a7', 2026, 20, 'Harvested', '12:00'),
  ('a8', 2026, 12, 'SetFruit', '12:00'), ('a8', 2026, 18, 'Harvested', '12:00'),
  ('b1', 2026, 12, 'SetFruit', '12:00'), ('b1', 2026, 22, 'Harvested', '12:00'),
  ('aa', 2026, 13, 'SetFruit', '12:00'), ('aa', 2026, 19, 'Harvested', '10:00'), ('aa', 2026, 19, 'BreakerFruit', '10:05'), ('aa', 2026, 20, 'Harvested', '12:00'),
  ('a0', 2026, 13, 'SetFruit', '12:00'), ('a0', 2026, 25, 'Harvested', '12:00'),
  ('c1', 2026, 13, 'SetFruit', '12:00'), ('c1', 2026, 27, 'Harvested', '12:00'),
  ('ad', 2026, 14, 'SetFruit', '12:00'), ('ad', 2026, 25, 'Harvested', '12:00'),
  ('ae', 2026, 14, 'SetFruit', '12:00'), ('ae', 2026, 27, 'Harvested', '12:00'),
  ('af', 2026, 35, 'SetFruit', '12:00'), ('af', 2026, 37, 'MatureGreen', '12:00'),
  ('bb', 2026, 35, 'SetFruit', '12:00'), ('bb', 2026, 36, 'Aborted', '12:00'),
  ('ab', 2026, 52, 'SetFruit', '12:00'), ('ab', 2027, 3, 'Harvested', '12:00'),
  ('a9', 2026, 12, 'Flower', '12:00'),   ('a9', 2026, 14, 'MatureGreen', '12:00'), ('a9', 2026, 16, 'Harvested', '12:00'),
  ('ac', 2026, 10, 'SetFruit', '12:00'), ('ac', 2026, 11, 'Harvested', '12:00')
) as v(n, y, w, s, t);
insert into public.node_observations (organization_id, crop_id, plant_node_id, year, week_number, status, observed_at) values
  ('bbbbbbbb-0000-4000-8000-0000000000b0', 'bbbbbbbb-0000-4000-8000-00000000c001', 'bbbbbbbb-0000-4000-8000-0000000003b9', 2026, 12, 'SetFruit', '2026-03-17 12:00Z'),
  ('bbbbbbbb-0000-4000-8000-0000000000b0', 'bbbbbbbb-0000-4000-8000-00000000c001', 'bbbbbbbb-0000-4000-8000-0000000003b9', 2026, 20, 'Harvested', '2026-05-12 12:00Z');

-- ── As user A ────────────────────────────────────────────────────────────────
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-4000-8000-000000000001","role":"authenticated"}', true);

do $$
declare
  crop constant uuid := 'aaaaaaaa-0000-4000-8000-00000000c001';
  as_of constant timestamptz := '2026-10-01 16:00Z';  -- Thursday of 2026-W40
  -- "+N:harvested/cohort_sets=percent[b]" for every cell whose cohort has sets; b = baseline cohort.
  ladder constant text := $q$
    select coalesce(string_agg(format('+%s:%s/%s=%s%s', c->>'delay', c->>'harvested', c->>'cohort_sets',
             coalesce(round((c->>'percent')::numeric, 2)::text, '—'), case when (c->>'is_baseline_cohort')::boolean then 'b' else '' end),
             ' ' order by (c->>'delay')::int), '')
    from public.set_harvest_cohorts($1, $2, $3) h, jsonb_array_elements(h.cells) c
    where h.iso_week = $4 and (c->>'cohort_sets')::int > 0 $q$;
  -- The closing cohort's Loss: "W<set week>:<loss %> a/p/t" or "—" while open.
  loss constant text := $q$
    select format('W%s:%s %s/%s/%s', closing->>'set_week', coalesce(round((closing->>'loss_percent')::numeric, 2)::text, '—'),
                  closing->>'aborted', closing->>'pruned', closing->>'timeout')
    from public.set_harvest_cohorts($1, $2, $3) where iso_week = $4 $q$;
  -- A cohort's outcome as seen from any cell: sets=harvested+aborted+pruned+timeout+on_plant, closed?
  fate constant text := $q$
    select distinct format('%s=%s+%s+%s+%s+%s %s', c->>'cohort_sets', c->>'cohort_harvested', c->>'cohort_aborted', c->>'cohort_pruned',
                  c->>'cohort_timeout', c->>'cohort_on_plant', case when (c->>'cohort_closed')::boolean then 'closed' else 'open' end)
    from public.set_harvest_cohorts($1, $2, $3) h, jsonb_array_elements(h.cells) c
    where (c->>'set_year')::int = $4 and (c->>'set_week')::int = $5 and (c->>'cohort_sets')::int > 0 $q$;
  got text;
  n integer;
  a integer;
  b integer;
begin
  -- Fixed +0 … +10 columns on every one of the 53 weeks.
  select count(*), min(jsonb_array_length(cells)), max(jsonb_array_length(cells)) into n, a, b from public.set_harvest_cohorts(crop, 2026, as_of);
  if (n, a, b) <> (53, 11, 11) then raise exception 'FAIL: rows/cells = % / %..%', n, a, b; end if;
  select string_agg(c->>'delay', ',') into got from public.set_harvest_cohorts(crop, 2026, as_of) h, jsonb_array_elements(h.cells) c where h.iso_week = 30;
  if got <> '0,1,2,3,4,5,6,7,8,9,10' then raise exception 'FAIL: delays = %', got; end if;

  -- SetFruit week = +0: the cohort's own row, nothing harvested at +0.
  execute ladder into got using crop, 2026, as_of, 10;
  if got <> '+0:0/3=0.00b' then raise exception 'FAIL: W10 = %', got; end if;
  select count(*) into n from public.set_harvest_cohorts(crop, 2026, as_of) h, jsonb_array_elements(h.cells) c where (c->>'delay')::int = 0 and (c->>'harvested')::int <> 0;
  if n <> 0 then raise exception 'FAIL: harvests at +0'; end if;

  -- Ladder coordinates: the W10 cohort is cell +k of row W10+k, for k = 0 … 10.
  select string_agg(format('W%s+%s', h.iso_week, c->>'delay'), ' ' order by h.iso_week) into got
    from public.set_harvest_cohorts(crop, 2026, as_of) h, jsonb_array_elements(h.cells) c
    where (c->>'set_year')::int = 2026 and (c->>'set_week')::int = 10;
  if got <> 'W10+0 W11+1 W12+2 W13+3 W14+4 W15+5 W16+6 W17+7 W18+8 W19+9 W20+10' then raise exception 'FAIL: W10 ladder = %', got; end if;

  -- Exact ages +1 … +10; the denominator is the whole original cohort; cells are not cumulative.
  execute ladder into got using crop, 2026, as_of, 15;
  if got <> '+1:0/2=0.00 +2:0/3=0.00 +3:0/3=0.00 +4:1/3=33.33 +5:0/3=0.00b' then raise exception 'FAIL: W15 = %', got; end if;
  execute ladder into got using crop, 2026, as_of, 16;  -- a1 +6; a9 (never set) is in no cell
  if got <> '+2:0/2=0.00 +3:0/3=0.00 +4:0/3=0.00 +5:0/3=0.00 +6:1/3=33.33b' then raise exception 'FAIL: W16 = %', got; end if;
  execute ladder into got using crop, 2026, as_of, 18;  -- a2's repeated Harvested isn't counted again; a8 is a side shoot (+6)
  if got <> '+4:0/2=0.00 +5:0/3=0.00 +6:1/3=33.33 +7:0/3=0.00 +8:0/3=0.00b' then raise exception 'FAIL: W18 = %', got; end if;
  execute ladder into got using crop, 2026, as_of, 20;  -- aa +7 (same-week correction ignored); a7 +8 with no breaker
  if got <> '+6:0/2=0.00 +7:1/3=33.33 +8:1/3=33.33 +9:0/3=0.00 +10:0/3=0.00b' then raise exception 'FAIL: W20 = %', got; end if;

  -- +10 Harvested counts as Harvested.
  execute ladder into got using crop, 2026, as_of, 22;
  if got <> '+8:0/2=0.00 +9:0/3=0.00 +10:1/3=33.33' then raise exception 'FAIL: W22 = %', got; end if;

  -- +11 / +12 (W25) and +13 / +14 (W27) Harvested: outside the window. No cohort cell, the cohorts
  -- keep them as Timeout, and raw Harvested is unchanged.
  execute ladder into got using crop, 2026, as_of, 25;
  if got <> '' then raise exception 'FAIL: W25 has cohort cells %', got; end if;
  execute ladder into got using crop, 2026, as_of, 27;
  if got <> '' then raise exception 'FAIL: W27 has cohort cells %', got; end if;
  select string_agg(format('W%s:%s=%s+%s+%s', iso_week, harvested_total, harvested_in_window, harvested_without_set, harvested_after_timeout), ' ' order by iso_week) into got
    from public.set_harvest_cohorts(crop, 2026, as_of) where iso_week in (25, 27);
  if got <> 'W25:2=0+0+2 W27:2=0+0+2' then raise exception 'FAIL: late-harvest reconciliation = %', got; end if;
  select string_agg(format('W%s:%s', iso_week, new_harvested), ' ' order by iso_week) into got from public.weekly_plant_data(crop, 2026, as_of) where iso_week in (22, 25, 27);
  if got <> 'W22:1 W25:2 W27:2' then raise exception 'FAIL: raw Harvested = %', got; end if;

  -- Losses and closed / open cohorts (sets = harvested + aborted + pruned + timeout + on plant).
  execute fate into got using crop, 2026, as_of, 2026, 10;
  if got <> '3=2+1+0+0+0 closed' then raise exception 'FAIL: W10 fate = %', got; end if;    -- Aborted
  execute fate into got using crop, 2026, as_of, 2026, 11;
  if got <> '3=1+0+1+1+0 closed' then raise exception 'FAIL: W11 fate = %', got; end if;    -- Pruned + Timeout (unresolved past +10)
  execute fate into got using crop, 2026, as_of, 2026, 13;
  if got <> '3=1+0+0+2+0 closed' then raise exception 'FAIL: W13 fate = %', got; end if;    -- +7 harvest; +12 and +14 harvests → Timeout
  execute fate into got using crop, 2026, as_of, 2026, 14;
  if got <> '2=0+0+0+2+0 closed' then raise exception 'FAIL: W14 fate = %', got; end if;    -- +11 and +13 harvests → Timeout
  execute fate into got using crop, 2026, as_of, 2026, 35;
  if got <> '2=0+1+0+0+1 open' then raise exception 'FAIL: W35 fate = %', got; end if;      -- open: lost so far + still on plant, not 100%

  -- Loss appears on the closing row (set week + 10) once the window has closed.
  execute loss into got using crop, 2026, as_of, 20;
  if got <> 'W10:33.33 1/0/0' then raise exception 'FAIL: W20 loss = %', got; end if;
  execute loss into got using crop, 2026, as_of, 21;
  if got <> 'W11:66.67 0/1/1' then raise exception 'FAIL: W21 loss = %', got; end if;
  execute loss into got using crop, 2026, as_of, 22;
  if got <> 'W12:0.00 0/0/0' then raise exception 'FAIL: W22 loss = %', got; end if;
  execute loss into got using crop, 2026, as_of, 23;
  if got <> 'W13:66.67 0/0/2' then raise exception 'FAIL: W23 loss = %', got; end if;
  execute loss into got using crop, 2026, as_of, 24;
  if got <> 'W14:100.00 0/0/2' then raise exception 'FAIL: W24 loss = %', got; end if;
  execute loss into got using crop, 2026, as_of, 45;
  if got <> 'W35:— 1/0/0' then raise exception 'FAIL: W45 loss (open cohort) = %', got; end if;
  execute loss into got using crop, 2026, as_of, 40;
  if got <> 'W30:— 0/0/0' then raise exception 'FAIL: W40 loss (no cohort) = %', got; end if;
  -- …and not before: in W14's +10 week (W24, in progress) it is still open, with no Timeout yet.
  execute loss into got using crop, 2026, '2026-06-10 16:00Z'::timestamptz, 24;
  if got <> 'W14:— 0/0/0' then raise exception 'FAIL: W24 loss while in progress = %', got; end if;
  execute fate into got using crop, 2026, '2026-06-10 16:00Z'::timestamptz, 2026, 14;
  if got <> '2=0+0+0+0+2 open' then raise exception 'FAIL: W14 fate while open = %', got; end if;
  execute loss into got using crop, 2026, '2026-06-17 16:00Z'::timestamptz, 24;
  if got <> 'W14:100.00 0/0/2' then raise exception 'FAIL: W24 loss after closing = %', got; end if;

  -- Closed cohorts reconcile to 100%: harvested within +10 + loss.
  select count(*) into n from public.set_harvest_cohorts(crop, 2026, as_of) h
    where (h.closing->>'closed')::boolean and (h.closing->>'sets')::int > 0
      and (h.closing->>'harvested')::int + (h.closing->>'aborted')::int + (h.closing->>'pruned')::int + (h.closing->>'timeout')::int <> (h.closing->>'sets')::int;
  if n <> 0 then raise exception 'FAIL: % closed cohorts do not reconcile to 100%%', n; end if;

  -- 0% vs —.
  select count(*) into n from public.set_harvest_cohorts(crop, 2026, as_of) h, jsonb_array_elements(h.cells) c
    where (c->>'cohort_sets')::int = 0 and c->>'percent' is not null;
  if n <> 0 then raise exception 'FAIL: % cells without a cohort have a percentage', n; end if;
  select count(*) into n from public.set_harvest_cohorts(crop, 2026, as_of) h, jsonb_array_elements(h.cells) c
    where (c->>'cohort_sets')::int > 0 and h.is_sampled and c->>'percent' is null;
  if n <> 0 then raise exception 'FAIL: % sampled cells with a cohort lack a percentage', n; end if;
  select count(*) into n from public.set_harvest_cohorts(crop, 2026, as_of) where iso_week < 10 and (is_sampled or cells::text like '%"percent": 0%');
  if n <> 0 then raise exception 'FAIL: weeks before sampling must be unsampled with no values'; end if;
  -- 2027-W04 is after S1's last observation: the 2026-W52 cohort exists, but the week wasn't sampled → —.
  execute ladder into got using crop, 2027, as_of, 4;
  if got <> '+5:0/1=—' then raise exception 'FAIL: 2027-W04 (unsampled) = %', got; end if;

  -- ISO-year boundary: the 2026-W52 cohort ages through W53 into 2027 (+4 = 2027-W03).
  select string_agg(format('%s-W%s+%s', y, h.iso_week, c->>'delay'), ' ' order by y, h.iso_week) into got
    from (select 2026 as y union all select 2027) years,
    lateral public.set_harvest_cohorts(crop, years.y, as_of) h, jsonb_array_elements(h.cells) c
    where (c->>'set_year')::int = 2026 and (c->>'set_week')::int = 52 and (c->>'delay')::int <= 4;
  if got <> '2026-W52+0 2026-W53+1 2027-W1+2 2027-W2+3 2027-W3+4' then raise exception 'FAIL: cross-year ladder = %', got; end if;
  execute ladder into got using crop, 2027, as_of, 3;
  if got <> '+4:1/1=100.00' then raise exception 'FAIL: 2027-W03 = %', got; end if;

  -- Baseline: only cells of the crop's first sampled week (2026-W10).
  select count(*) into n from public.set_harvest_cohorts(crop, 2026, as_of) h, jsonb_array_elements(h.cells) c
    where (c->>'is_baseline_cohort')::boolean and not ((c->>'set_year')::int = 2026 and (c->>'set_week')::int = 10);
  if n <> 0 then raise exception 'FAIL: % non-W10 cells flagged baseline', n; end if;
  select count(*) into n from public.set_harvest_cohorts(crop, 2026, as_of) where (closing->>'is_baseline_cohort')::boolean and iso_week <> 20;
  if n <> 0 then raise exception 'FAIL: baseline closing flag on the wrong row'; end if;

  -- Reconciliation and raw Harvested/m² unchanged: 12 raw = 7 within window + 1 without set + 4 after the +10 window.
  select sum(harvested_total), sum(harvested_in_window), sum(harvested_without_set) into n, a, b from public.set_harvest_cohorts(crop, 2026, as_of);
  if (n, a, b) <> (12, 7, 1) then raise exception 'FAIL: 2026 total/in window/without set = %/%/%', n, a, b; end if;
  select sum(harvested_after_timeout) into n from public.set_harvest_cohorts(crop, 2026, as_of);
  if n <> 4 then raise exception 'FAIL: 2026 after timeout = %', n; end if;
  select sum(new_harvested) into n from public.weekly_plant_data(crop, 2026, as_of);
  if n <> 12 then raise exception 'FAIL: raw 2026 Harvested = %', n; end if;
  select format('%s=%s+%s+%s', harvested_total, harvested_in_window, harvested_without_set, harvested_after_timeout) into got
    from public.set_harvest_cohorts(crop, 2026, as_of) where iso_week = 16;
  if got <> '2=1+1+0' then raise exception 'FAIL: W16 reconciliation = %', got; end if;

  -- In progress: the current week still shows values, flagged provisional.
  execute ladder into got using crop, 2026, '2026-04-15 16:00Z'::timestamptz, 16;
  select count(*) into n from public.set_harvest_cohorts(crop, 2026, '2026-04-15 16:00Z') where is_provisional and iso_week = 16;
  if n <> 1 or got <> '+2:0/2=0.00 +3:0/3=0.00 +4:0/3=0.00 +5:0/3=0.00 +6:1/3=33.33b' then raise exception 'FAIL: in-progress W16 = %', got; end if;

  -- Raw observations are untouched: the +11 … +14 Harvested records are all still there.
  select count(*) into n from public.node_observations
    where plant_node_id in ('aaaaaaaa-0000-4000-8000-0000000003ad', 'aaaaaaaa-0000-4000-8000-0000000003a0',
                            'aaaaaaaa-0000-4000-8000-0000000003ae', 'aaaaaaaa-0000-4000-8000-0000000003c1') and status = 'Harvested';
  if n <> 4 then raise exception 'FAIL: raw late Harvested records = %', n; end if;

  -- Another organization's crop: nothing.
  select count(*) into n from public.set_harvest_cohorts('bbbbbbbb-0000-4000-8000-00000000c001', 2026, as_of);
  if n <> 0 then raise exception 'FAIL: user A read % rows of org B''s cohorts', n; end if;
  select count(*) into n from public.crop_node_weeks('bbbbbbbb-0000-4000-8000-00000000c001');
  if n <> 0 then raise exception 'FAIL: user A read % of org B''s node weeks', n; end if;
end $$;

-- ── As user B ────────────────────────────────────────────────────────────────
select set_config('request.jwt.claims', '{"sub":"bbbbbbbb-0000-4000-8000-000000000001","role":"authenticated"}', true);
do $$
declare n integer; h integer;
begin
  select count(*) into n from public.set_harvest_cohorts('aaaaaaaa-0000-4000-8000-00000000c001', 2026);
  if n <> 0 then raise exception 'FAIL: user B read % rows of org A''s cohorts', n; end if;
  -- B's own crop: one W12 set harvested at +8, unaffected by A's data.
  select count(*), sum(harvested_in_window) into n, h from public.set_harvest_cohorts('bbbbbbbb-0000-4000-8000-00000000c001', 2026);
  if (n, h) <> (53, 1) then raise exception 'FAIL: user B own crop rows=% harvested=%', n, h; end if;
end $$;

-- ── Anonymous ────────────────────────────────────────────────────────────────
select set_config('request.jwt.claims', '{"role":"anon"}', true);
set local role anon;
do $$
begin
  perform public.set_harvest_cohorts('aaaaaaaa-0000-4000-8000-00000000c001', 2026);
  raise exception 'FAIL: anon can call set_harvest_cohorts';
exception when insufficient_privilege then null;
end $$;

reset role;
select 'set_harvest_cohorts tests passed' as result;
rollback;
