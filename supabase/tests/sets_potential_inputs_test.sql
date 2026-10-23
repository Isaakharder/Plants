-- 20261108000000_sets_potential_inputs: weekly_new_sets() catch-up counts and
-- set_cohort_outcomes() outcomes by age, from Plants observations only.
--
-- Runs inside a transaction that is always rolled back.
-- Prints {"result": "sets_potential_inputs tests passed"} on success.

begin;

-- ── Fixture: one stem; W10 is the crop's baseline ──────────────────────────
--   n1 node 3: W10 set (baseline cohort) → W17 Harvested (age 7)
--   n2 node 4: W10 Flower, W11 set → W12 Aborted (age 1)
--   n5 node 2: first recorded W11 already set, below node 4 recorded in W10: catch-up → W14 Pruned (age 3)
--   n6 node 5: first recorded W11 already set, above every earlier node → W12 Aborted (a mis-tap), W13 set again: still on the plant
insert into auth.users (id, email, aud, role) values
  ('cccccccc-0000-4000-8000-00000000c001', 'spi@example.invalid', 'authenticated', 'authenticated'),
  ('cccccccc-0000-4000-8000-00000000c999', 'spi-out@example.invalid', 'authenticated', 'authenticated');
insert into public.organizations (id, name) values ('cccccccc-0000-4000-8000-00000000c0a0', 'SPI Org');
insert into public.organization_members (organization_id, user_id, role) values
  ('cccccccc-0000-4000-8000-00000000c0a0', 'cccccccc-0000-4000-8000-00000000c001', 'owner');
insert into public.crops (id, organization_id, name, color, planting_date, pullout_date, area_m2, picking_stems, pepper_type_id) values
  ('cccccccc-0000-4000-8000-00000000cc01', 'cccccccc-0000-4000-8000-00000000c0a0', 'Crop S', 'red', '2026-01-01', '2026-12-31', 100, 700, (select t.id from public.pepper_types t where t.organization_id = 'cccccccc-0000-4000-8000-00000000c0a0' and t.key = 'bell'));
insert into public.measurement_rows (id, organization_id, crop_id, row_name) values
  ('cccccccc-0000-4000-8000-00000000c1a1', 'cccccccc-0000-4000-8000-00000000c0a0', 'cccccccc-0000-4000-8000-00000000cc01', 'Row S');
insert into public.measurement_stems (id, organization_id, crop_id, measurement_row_id, stem_name) values
  ('cccccccc-0000-4000-8000-00000000c2a1', 'cccccccc-0000-4000-8000-00000000c0a0', 'cccccccc-0000-4000-8000-00000000cc01', 'cccccccc-0000-4000-8000-00000000c1a1', 'S1');
insert into public.plant_nodes (id, organization_id, crop_id, measurement_stem_id, node_number, is_side_shoot, is_active)
select ('cccccccc-0000-4000-8000-00000000c3' || id)::uuid, 'cccccccc-0000-4000-8000-00000000c0a0', 'cccccccc-0000-4000-8000-00000000cc01',
       'cccccccc-0000-4000-8000-00000000c2a1', num, false, true
from (values ('a1', 3), ('a2', 4), ('a5', 2), ('a6', 5)) v(id, num);
insert into public.node_observations (organization_id, crop_id, plant_node_id, year, week_number, status, observed_at)
select 'cccccccc-0000-4000-8000-00000000c0a0', 'cccccccc-0000-4000-8000-00000000cc01', ('cccccccc-0000-4000-8000-00000000c3' || n)::uuid,
       2026, w, s, to_date('2026-' || lpad(w::text, 2, '0'), 'IYYY-IW') + interval '1 day 12 hours'
from (values
  ('a1', 10, 'SetFruit'), ('a1', 17, 'Harvested'),
  ('a2', 10, 'Flower'), ('a2', 11, 'SetFruit'), ('a2', 12, 'Aborted'),
  ('a5', 11, 'SetFruit'), ('a5', 14, 'Pruned'),
  ('a6', 11, 'SetFruit'), ('a6', 12, 'Aborted'), ('a6', 13, 'SetFruit')
) v(n, w, s);

-- ── weekly_new_sets ─────────────────────────────────────────────────────────
do $$
declare r record;
begin
  select * into r from public.weekly_new_sets('cccccccc-0000-4000-8000-00000000cc01', 2026) where iso_week = 11;
  if r.new_sets <> 3 or r.catchup_sets <> 1 or r.first_seen_set <> 2 then
    raise exception 'W11: % new, % catch-up, % first seen set (expected 3, 1, 2)', r.new_sets, r.catchup_sets, r.first_seen_set;
  end if;
  select * into r from public.weekly_new_sets('cccccccc-0000-4000-8000-00000000cc01', 2026) where iso_week = 10;
  if not r.is_baseline or r.catchup_sets <> 0 then raise exception 'W10 should be the baseline without catch-up: %', r; end if;
  -- The same Sets/m² as weekly_plant_data, every week.
  if exists (
    select 1 from public.weekly_new_sets('cccccccc-0000-4000-8000-00000000cc01', 2026) n
      join public.weekly_plant_data('cccccccc-0000-4000-8000-00000000cc01', 2026) w using (iso_week)
     where n.sets_per_m2 is distinct from w.sets_per_m2 or n.new_sets <> w.new_sets
  ) then
    raise exception 'weekly_new_sets differs from weekly_plant_data';
  end if;
end $$;

-- ── set_cohort_outcomes ─────────────────────────────────────────────────────
do $$
declare r record;
begin
  select * into r from public.set_cohort_outcomes('cccccccc-0000-4000-8000-00000000cc01', 2026) where set_week = 10;
  if not r.is_baseline or r.sets <> 1 or r.harvested_by_age[8] <> 1 or r.on_plant <> 0 then raise exception 'W10 cohort: %', r; end if;
  select * into r from public.set_cohort_outcomes('cccccccc-0000-4000-8000-00000000cc01', 2026) where set_week = 11;
  if r.is_baseline or r.sets <> 3 then raise exception 'W11 cohort: %', r; end if;
  if r.aborted_by_age[2] <> 1 or (select sum(x) from unnest(r.aborted_by_age) x) <> 1 then raise exception 'W11 aborted by age: %', r.aborted_by_age; end if;
  if r.pruned_by_age[4] <> 1 or (select sum(x) from unnest(r.pruned_by_age) x) <> 1 then raise exception 'W11 pruned by age: %', r.pruned_by_age; end if;
  -- The mis-tapped abort is not a loss: that pepper is still on the plant.
  if r.on_plant <> 1 or (select sum(x) from unnest(r.harvested_by_age) x) <> 0 then raise exception 'W11 on plant / harvested: %', r; end if;
  if array_length(r.harvested_by_age, 1) <> 11 then raise exception 'ages 0 … 10 expected'; end if;
end $$;

-- Every cohort of every crop adds up to its sets.
do $$
begin
  if exists (
    select 1 from public.crops c, public.set_cohort_outcomes(c.id, 2026) o
     where (select sum(x) from unnest(o.harvested_by_age) x) + (select sum(x) from unnest(o.aborted_by_age) x)
         + (select sum(x) from unnest(o.pruned_by_age) x) + o.resolved_later + o.on_plant <> o.sets
  ) then
    raise exception 'cohort outcomes do not add up to sets';
  end if;
end $$;

-- ── Access: members only (security invoker, RLS); never anon ────────────────
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "cccccccc-0000-4000-8000-00000000c999", "role": "authenticated"}', true);
do $$
begin
  if exists (select 1 from public.set_cohort_outcomes('cccccccc-0000-4000-8000-00000000cc01', 2026)) then raise exception 'an outsider sees cohorts'; end if;
  if exists (select 1 from public.weekly_new_sets('cccccccc-0000-4000-8000-00000000cc01', 2026) where new_sets > 0) then raise exception 'an outsider sees sets'; end if;
end $$;
select set_config('request.jwt.claims', '{"sub": "cccccccc-0000-4000-8000-00000000c001", "role": "authenticated"}', true);
do $$
begin
  if (select count(*) from public.set_cohort_outcomes('cccccccc-0000-4000-8000-00000000cc01', 2026)) <> 2 then raise exception 'the member does not see the cohorts'; end if;
end $$;
reset role;
set local role anon;
do $$
begin
  perform public.set_cohort_outcomes('cccccccc-0000-4000-8000-00000000cc01', 2026);
  raise exception 'anon can call set_cohort_outcomes';
exception when insufficient_privilege then null;
end $$;
reset role;

select '{"result": "sets_potential_inputs tests passed"}' as result;
rollback;
