-- weekly_fruit_loss(): Fruit Loss % per calendar week — population and
-- numerator rules (fruit only from the week after it sets, confirmed losses
-- counted once, contradicted losses retracted, flowers kept separate, sampled
-- stems only), ISO-year boundary, unsampled and in-progress weeks,
-- reconciliation over every crop, and organization isolation.
--
-- Runs inside a transaction that is always rolled back.
--   npx supabase db query --linked -f supabase/tests/weekly_fruit_loss_test.sql
-- Prints {"result": "weekly_fruit_loss tests passed"} on success.

begin;

-- ── Reconciliation over every crop already in the database ──────────────────
do $$
declare r record;
begin
  for r in
    select c.id as crop_id, c.name, y.year
    from public.crops c
    join lateral (select distinct o.year from public.node_observations o where o.crop_id = c.id) y on true
  loop
    perform 1
    from public.weekly_fruit_loss(r.crop_id, r.year) f
    join public.weekly_plant_data(r.crop_id, r.year) w using (iso_week)
    where f.fruit_lost > f.fruit_at_start
       or f.fruit_aborted + f.fruit_pruned <> f.fruit_lost
       or f.fruit_aborted < 0 or f.fruit_pruned < 0 or f.flower_lost < 0
       or f.is_sampled <> w.is_sampled or f.is_provisional <> w.is_provisional
       or (f.fruit_loss_percent is null) <> (not w.is_sampled or f.fruit_at_start = 0)
       or f.fruit_loss_percent <> f.fruit_lost * 100.0 / nullif(f.fruit_at_start, 0)
       or (f.fruit_lost_per_m2 is null) <> (not w.is_sampled)
       or f.fruit_lost_per_m2 <> f.fruit_lost / w.sampled_m2;
    if found then raise exception 'FAIL: weekly_fruit_loss inconsistent for crop % (%), year %', r.name, r.crop_id, r.year; end if;
  end loop;
end $$;

-- ── Fixture ──────────────────────────────────────────────────────────────────
insert into auth.users (id, email, aud, role) values
  ('aaaaaaaa-0000-4000-8000-0000000f1001', 'wfl-test-a@example.invalid', 'authenticated', 'authenticated'),
  ('bbbbbbbb-0000-4000-8000-0000000f1001', 'wfl-test-b@example.invalid', 'authenticated', 'authenticated');
insert into public.organizations (id, name) values
  ('aaaaaaaa-0000-4000-8000-0000000f10a0', 'WFL Org A'),
  ('bbbbbbbb-0000-4000-8000-0000000f10b0', 'WFL Org B');
insert into public.organization_members (organization_id, user_id, role) values
  ('aaaaaaaa-0000-4000-8000-0000000f10a0', 'aaaaaaaa-0000-4000-8000-0000000f1001', 'owner'),
  ('bbbbbbbb-0000-4000-8000-0000000f10b0', 'bbbbbbbb-0000-4000-8000-0000000f1001', 'owner');
-- 700 stems on 100 m²: 7 stems/m², so one sampled stem is 1/7 m².
insert into public.crops (id, organization_id, name, color, planting_date, pullout_date, area_m2, picking_stems) values
  ('aaaaaaaa-0000-4000-8000-0000000f1c01', 'aaaaaaaa-0000-4000-8000-0000000f10a0', 'Crop A', 'red', '2025-12-01', '2026-12-01', 100, 700);
insert into public.measurement_rows (id, organization_id, crop_id, row_name) values
  ('aaaaaaaa-0000-4000-8000-0000000f1101', 'aaaaaaaa-0000-4000-8000-0000000f10a0', 'aaaaaaaa-0000-4000-8000-0000000f1c01', 'Row A');
-- S1 is sampled 2025-W52 … 2026-W16; S2 only 2026-W10 … W11.
insert into public.measurement_stems (id, organization_id, crop_id, measurement_row_id, stem_name) values
  ('aaaaaaaa-0000-4000-8000-0000000f1201', 'aaaaaaaa-0000-4000-8000-0000000f10a0', 'aaaaaaaa-0000-4000-8000-0000000f1c01', 'aaaaaaaa-0000-4000-8000-0000000f1101', 'S1'),
  ('aaaaaaaa-0000-4000-8000-0000000f1202', 'aaaaaaaa-0000-4000-8000-0000000f10a0', 'aaaaaaaa-0000-4000-8000-0000000f1c01', 'aaaaaaaa-0000-4000-8000-0000000f1101', 'S2');
insert into public.plant_nodes (id, organization_id, crop_id, measurement_stem_id, node_number, is_active)
select ('aaaaaaaa-0000-4000-8000-0000000f13' || id)::uuid, 'aaaaaaaa-0000-4000-8000-0000000f10a0', 'aaaaaaaa-0000-4000-8000-0000000f1c01',
       ('aaaaaaaa-0000-4000-8000-0000000f120' || stem)::uuid, num, active
from (values
  ('01', '1', 1, true),  -- 2025-W52 set → 2026-W02 Aborted (fruit across New Year)
  ('02', '1', 2, true),  -- W10 set → W12 Aborted, repeated W13 (counts once, in W12)
  ('03', '1', 3, true),  -- W10 Flower → W11 Aborted (flower loss)
  ('04', '1', 4, true),  -- W11 Aborted, its first record (flower loss)
  ('05', '1', 5, true),  -- W10 set → W11 Aborted (mis-tap) → W13 MatureGreen → W15 Harvested: never lost
  ('06', '1', 6, true),  -- W10 Aborted (mis-tap) → W11 set → W13 Pruned: fruit lost in W13, not a W10 flower loss
  ('07', '1', 7, true),  -- W10 set → W12 Harvested: on the plant W11 and W12, gone after
  ('08', '1', 8, true),  -- W14 set → W16 MatureGreen: not on the plant in W14 (sets that week)
  ('09', '1', 9, false), -- removed in the collector: W10 set → W11 Aborted, ignored
  ('10', '2', 1, true)   -- S2: W10 set, repeated W11; S2 isn't sampled after W11
) as v(id, stem, num, active);

insert into public.node_observations (organization_id, crop_id, plant_node_id, year, week_number, status, observed_at)
select 'aaaaaaaa-0000-4000-8000-0000000f10a0', 'aaaaaaaa-0000-4000-8000-0000000f1c01', ('aaaaaaaa-0000-4000-8000-0000000f13' || n)::uuid,
       y, w, s, to_date(y || '-' || lpad(w::text, 2, '0'), 'IYYY-IW') + interval '1 day 12 hours'
from (values
  ('01', 2025, 52, 'SetFruit'), ('01', 2026, 2, 'Aborted'),
  ('02', 2026, 10, 'SetFruit'), ('02', 2026, 12, 'Aborted'), ('02', 2026, 13, 'Aborted'),
  ('03', 2026, 10, 'Flower'), ('03', 2026, 11, 'Aborted'),
  ('04', 2026, 11, 'Aborted'),
  ('05', 2026, 10, 'SetFruit'), ('05', 2026, 11, 'Aborted'), ('05', 2026, 13, 'MatureGreen'), ('05', 2026, 15, 'Harvested'),
  ('06', 2026, 10, 'Aborted'), ('06', 2026, 11, 'SetFruit'), ('06', 2026, 13, 'Pruned'),
  ('07', 2026, 10, 'SetFruit'), ('07', 2026, 12, 'Harvested'),
  ('08', 2026, 14, 'SetFruit'), ('08', 2026, 16, 'MatureGreen'),
  ('09', 2026, 10, 'SetFruit'), ('09', 2026, 11, 'Aborted'),
  ('10', 2026, 10, 'SetFruit'), ('10', 2026, 11, 'SetFruit')
) as v(n, y, w, s);

-- ── As user A ────────────────────────────────────────────────────────────────
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-4000-8000-0000000f1001","role":"authenticated"}', true);
do $$
declare
  got text;
  want text := concat_ws(' | ',
    -- week: at_start / lost / aborted / pruned / flowers / percent
    'W1 1/0/0/0/0/0.0',
    'W2 1/1/1/0/0/100.0',      -- across New Year: set 2025-W52, lost 2026-W02
    'W3 0/0/0/0/0/—',          -- sampled, no fruit: no percentage
    'W10 0/0/0/0/0/—',         -- W10 sets are not on the plant yet; node 06's W10 Aborted is retracted
    'W11 4/0/0/0/2/0.0',       -- 02, 05, 07 + S2's 10; node 05's W11 Aborted is retracted; flowers 03, 04
    'W12 4/1/1/0/0/25.0',      -- 02, 05, 06, 07 (harvested this week); S2 not sampled; 02 lost once
    'W13 2/1/0/1/0/50.0',      -- 05, 06; 06 pruned
    'W14 1/0/0/0/0/0.0',       -- 05; 08 sets this week
    'W15 2/0/0/0/0/0.0',       -- 05 (harvested this week), 08
    'W16 1/0/0/0/0/0.0',       -- 08 (in progress)
    'W17 0/0/0/0/0/—');        -- no stem sampled: no percentage
  r record; per_m2 numeric;
begin
  select string_agg(format('W%s %s/%s/%s/%s/%s/%s', iso_week, fruit_at_start, fruit_lost, fruit_aborted, fruit_pruned, flower_lost,
                           coalesce(round(fruit_loss_percent, 1)::text, '—')), ' | ' order by iso_week)
    into got
    from public.weekly_fruit_loss('aaaaaaaa-0000-4000-8000-0000000f1c01', 2026, '2026-04-15 12:00-04')
    where iso_week in (1, 2, 3, 10, 11, 12, 13, 14, 15, 16, 17);
  if got is distinct from want then raise exception E'FAIL: weekly fruit loss\n got:  %\n want: %', got, want; end if;

  -- Per m²: W12 has one sampled stem (1/7 m²), so 1 fruit lost = 7 per m²; W17 isn't sampled.
  select * into r from public.weekly_fruit_loss('aaaaaaaa-0000-4000-8000-0000000f1c01', 2026, '2026-04-15 12:00-04') where iso_week = 12;
  if round(r.fruit_lost_per_m2, 9) <> 7 or not r.is_sampled or r.is_provisional then raise exception 'FAIL: W12 per m² / flags %', r; end if;
  select * into r from public.weekly_fruit_loss('aaaaaaaa-0000-4000-8000-0000000f1c01', 2026, '2026-04-15 12:00-04') where iso_week = 16;
  if not r.is_provisional then raise exception 'FAIL: W16 should be in progress'; end if;
  select * into r from public.weekly_fruit_loss('aaaaaaaa-0000-4000-8000-0000000f1c01', 2026, '2026-04-15 12:00-04') where iso_week = 17;
  if r.is_sampled or r.fruit_lost_per_m2 is not null or r.fruit_loss_percent is not null then raise exception 'FAIL: W17 should be unsampled %', r; end if;

  -- 2025 sees the same fruit from the other side of New Year: on the plant from 2026-W01, not in 2025-W52.
  select fruit_at_start into per_m2 from public.weekly_fruit_loss('aaaaaaaa-0000-4000-8000-0000000f1c01', 2025, '2026-04-15 12:00-04') where iso_week = 52;
  if per_m2 <> 0 then raise exception 'FAIL: 2025-W52 at start %', per_m2; end if;

  -- One row per ISO week.
  if (select count(*) from public.weekly_fruit_loss('aaaaaaaa-0000-4000-8000-0000000f1c01', 2026)) <> 53 then raise exception 'FAIL: 2026 has 53 weeks'; end if;
end $$;

-- ── As user B (another organization) ─────────────────────────────────────────
select set_config('request.jwt.claims', '{"sub":"bbbbbbbb-0000-4000-8000-0000000f1001","role":"authenticated"}', true);
do $$
begin
  if exists (select 1 from public.weekly_fruit_loss('aaaaaaaa-0000-4000-8000-0000000f1c01', 2026)) then
    raise exception 'FAIL: B sees A''s fruit loss';
  end if;
end $$;

-- ── anon can't call it ────────────────────────────────────────────────────────
reset role;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
set local role anon;
do $$
begin
  perform public.weekly_fruit_loss('aaaaaaaa-0000-4000-8000-0000000f1c01', 2026);
  raise exception 'FAIL: anon can call weekly_fruit_loss';
exception when insufficient_privilege then null;
end $$;

reset role;
select 'weekly_fruit_loss tests passed' as result;
rollback;
