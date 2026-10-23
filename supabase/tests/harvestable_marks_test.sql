-- harvestable_marks and weekly_harvestable(): a same-week count that never
-- touches a node's status history or any existing weekly calculation.
--
-- Runs inside a transaction that is always rolled back.
-- Prints {"result": "harvestable_marks tests passed"} on success.

begin;

-- ── Fixture ──────────────────────────────────────────────────────────────────
-- Org A: one crop, 700 picking stems on 100 m², two sampled stems.
--   W42 (Friday)  S1: B1, B2 BreakerFruit; G1 MatureGreen. S2: B3 BreakerFruit.
--                 Both stems checked.
--   W43           Wednesday: the Harvestable count (below). Friday: the
--                 normal walkthrough.
insert into auth.users (id, email, aud, role) values
  ('aaaaaaaa-0000-4000-8000-00000000e001', 'hv-test-a@example.invalid', 'authenticated', 'authenticated'),
  ('bbbbbbbb-0000-4000-8000-00000000e001', 'hv-test-b@example.invalid', 'authenticated', 'authenticated');
insert into public.organizations (id, name) values
  ('aaaaaaaa-0000-4000-8000-00000000e0a0', 'HV Org A'),
  ('bbbbbbbb-0000-4000-8000-00000000e0b0', 'HV Org B');
insert into public.organization_members (organization_id, user_id, role) values
  ('aaaaaaaa-0000-4000-8000-00000000e0a0', 'aaaaaaaa-0000-4000-8000-00000000e001', 'owner'),
  ('bbbbbbbb-0000-4000-8000-00000000e0b0', 'bbbbbbbb-0000-4000-8000-00000000e001', 'owner');
insert into public.crops (id, organization_id, name, color, planting_date, pullout_date, area_m2, picking_stems, pepper_type_id) values
  ('aaaaaaaa-0000-4000-8000-00000000ec01', 'aaaaaaaa-0000-4000-8000-00000000e0a0', 'Crop A', 'yellow', '2026-01-05', '2026-12-01', 100, 700, (select t.id from public.pepper_types t where t.organization_id = 'aaaaaaaa-0000-4000-8000-00000000e0a0' and t.key = 'bell'));
insert into public.measurement_rows (id, organization_id, crop_id, row_name) values
  ('aaaaaaaa-0000-4000-8000-00000000e101', 'aaaaaaaa-0000-4000-8000-00000000e0a0', 'aaaaaaaa-0000-4000-8000-00000000ec01', 'Row A');
insert into public.measurement_stems (id, organization_id, crop_id, measurement_row_id, stem_name, sort_order) values
  ('aaaaaaaa-0000-4000-8000-00000000e201', 'aaaaaaaa-0000-4000-8000-00000000e0a0', 'aaaaaaaa-0000-4000-8000-00000000ec01', 'aaaaaaaa-0000-4000-8000-00000000e101', 'S1', 1),
  ('aaaaaaaa-0000-4000-8000-00000000e202', 'aaaaaaaa-0000-4000-8000-00000000e0a0', 'aaaaaaaa-0000-4000-8000-00000000ec01', 'aaaaaaaa-0000-4000-8000-00000000e101', 'S2', 2);

-- Week w of 2026, day d (1 = Monday) at noon Toronto.
create function pg_temp.at(w integer, d integer) returns timestamptz language sql immutable as
  $$ select (to_date('2026-' || lpad(w::text, 2, '0'), 'IYYY-IW') + (d - 1) + time '12:00') at time zone 'America/Toronto' $$;

insert into public.plant_nodes (id, organization_id, crop_id, measurement_stem_id, node_number, created_at)
select id::uuid, 'aaaaaaaa-0000-4000-8000-00000000e0a0', 'aaaaaaaa-0000-4000-8000-00000000ec01', stem::uuid, num, pg_temp.at(40, 5)
from (values
  ('aaaaaaaa-0000-4000-8000-00000000e301', 'aaaaaaaa-0000-4000-8000-00000000e201', 1),  -- B1
  ('aaaaaaaa-0000-4000-8000-00000000e302', 'aaaaaaaa-0000-4000-8000-00000000e201', 2),  -- B2
  ('aaaaaaaa-0000-4000-8000-00000000e303', 'aaaaaaaa-0000-4000-8000-00000000e201', 3),  -- G1
  ('aaaaaaaa-0000-4000-8000-00000000e304', 'aaaaaaaa-0000-4000-8000-00000000e202', 1)   -- B3
) n(id, stem, num);

insert into public.node_observations (id, organization_id, crop_id, plant_node_id, year, week_number, status, observed_at)
select gen_random_uuid(), 'aaaaaaaa-0000-4000-8000-00000000e0a0', 'aaaaaaaa-0000-4000-8000-00000000ec01', node::uuid, 2026, w, status, pg_temp.at(w, 5)
from (values
  ('aaaaaaaa-0000-4000-8000-00000000e301', 40, 'SetFruit'), ('aaaaaaaa-0000-4000-8000-00000000e301', 42, 'BreakerFruit'),
  ('aaaaaaaa-0000-4000-8000-00000000e302', 40, 'SetFruit'), ('aaaaaaaa-0000-4000-8000-00000000e302', 42, 'BreakerFruit'),
  ('aaaaaaaa-0000-4000-8000-00000000e303', 40, 'SetFruit'), ('aaaaaaaa-0000-4000-8000-00000000e303', 42, 'MatureGreen'),
  ('aaaaaaaa-0000-4000-8000-00000000e304', 40, 'SetFruit'), ('aaaaaaaa-0000-4000-8000-00000000e304', 42, 'BreakerFruit')
) o(node, w, status);
insert into public.stem_visits (organization_id, crop_id, measurement_stem_id, year, week_number, observed_at)
select 'aaaaaaaa-0000-4000-8000-00000000e0a0', 'aaaaaaaa-0000-4000-8000-00000000ec01', s::uuid, 2026, w, pg_temp.at(w, 5)
from (values ('aaaaaaaa-0000-4000-8000-00000000e201'), ('aaaaaaaa-0000-4000-8000-00000000e202')) s(s), (values (40), (42)) w(w);

-- Everything the existing calculations return, before any mark (as of W43 Saturday).
create temp table before_marks as
select
  (select jsonb_agg(t order by t.iso_week) from public.weekly_plant_data('aaaaaaaa-0000-4000-8000-00000000ec01', 2026, pg_temp.at(43, 6)) t) as plant_data,
  (select jsonb_agg(t order by t.iso_week) from public.weekly_fruit_loss('aaaaaaaa-0000-4000-8000-00000000ec01', 2026, pg_temp.at(43, 6)) t) as fruit_loss,
  (select jsonb_agg(t order by t.iso_week) from public.set_harvest_cohorts('aaaaaaaa-0000-4000-8000-00000000ec01', 2026, pg_temp.at(43, 6)) t) as cohorts,
  (select jsonb_agg(t order by t.iso_week) from public.sampling_weeks('aaaaaaaa-0000-4000-8000-00000000ec01', 2026, pg_temp.at(43, 6)) t) as sampling,
  (select jsonb_agg(t order by t.plant_node_id) from public.crop_node_stages('aaaaaaaa-0000-4000-8000-00000000ec01') t) as stages,
  (select jsonb_agg(t order by t.plant_node_id) from public.node_latest_statuses t where t.crop_id = 'aaaaaaaa-0000-4000-8000-00000000ec01') as latest;
grant select on before_marks to authenticated;

-- ── As a member of A ─────────────────────────────────────────────────────────
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-4000-8000-00000000e001","role":"authenticated"}', true);

-- Wednesday W43: B1 marked twice (a double tap), B2 marked, G1 marked then
-- taken back, B3 marked. S2 has no other record in W43.
insert into public.harvestable_marks (organization_id, crop_id, plant_node_id, year, week_number, harvestable, observed_at)
select 'aaaaaaaa-0000-4000-8000-00000000e0a0', 'aaaaaaaa-0000-4000-8000-00000000ec01', node::uuid, 2026, 43, h, pg_temp.at(43, 3) + make_interval(mins => m)
from (values
  ('aaaaaaaa-0000-4000-8000-00000000e301', true, 0), ('aaaaaaaa-0000-4000-8000-00000000e301', true, 1),
  ('aaaaaaaa-0000-4000-8000-00000000e302', true, 2),
  ('aaaaaaaa-0000-4000-8000-00000000e303', true, 3), ('aaaaaaaa-0000-4000-8000-00000000e303', false, 4),
  ('aaaaaaaa-0000-4000-8000-00000000e304', true, 5)
) m(node, h, m);

-- Breaker → Harvestable: statuses, stages, breaker counts, fruit loss, cohorts
-- and sampled stems are exactly as before; S2 is not made "visited" in W43.
do $$
declare b before_marks;
begin
  select * into b from before_marks;
  if (select jsonb_agg(t order by t.plant_node_id) from public.node_latest_statuses t where t.crop_id = 'aaaaaaaa-0000-4000-8000-00000000ec01') is distinct from b.latest
    then raise exception 'FAIL: a mark changed a latest status'; end if;
  if (select jsonb_agg(t order by t.plant_node_id) from public.crop_node_stages('aaaaaaaa-0000-4000-8000-00000000ec01') t) is distinct from b.stages
    then raise exception 'FAIL: a mark changed breaker or harvest weeks'; end if;
  if (select jsonb_agg(t order by t.iso_week) from public.weekly_plant_data('aaaaaaaa-0000-4000-8000-00000000ec01', 2026, pg_temp.at(43, 6)) t) is distinct from b.plant_data
    then raise exception 'FAIL: a mark changed weekly_plant_data'; end if;
  if (select jsonb_agg(t order by t.iso_week) from public.weekly_fruit_loss('aaaaaaaa-0000-4000-8000-00000000ec01', 2026, pg_temp.at(43, 6)) t) is distinct from b.fruit_loss
    then raise exception 'FAIL: a mark changed weekly_fruit_loss'; end if;
  if (select jsonb_agg(t order by t.iso_week) from public.set_harvest_cohorts('aaaaaaaa-0000-4000-8000-00000000ec01', 2026, pg_temp.at(43, 6)) t) is distinct from b.cohorts
    then raise exception 'FAIL: a mark changed set_harvest_cohorts'; end if;
  if (select jsonb_agg(t order by t.iso_week) from public.sampling_weeks('aaaaaaaa-0000-4000-8000-00000000ec01', 2026, pg_temp.at(43, 6)) t) is distinct from b.sampling
    then raise exception 'FAIL: a mark changed sampling_weeks'; end if;
  if (select status from public.node_latest_statuses where plant_node_id = 'aaaaaaaa-0000-4000-8000-00000000e301') <> 'BreakerFruit'
    then raise exception 'FAIL: B1 is no longer a Breaker'; end if;
end $$;

-- Counted once per node and week; a taken-back mark doesn't count; W43 only.
do $$
declare r record;
begin
  select * into r from public.weekly_harvestable('aaaaaaaa-0000-4000-8000-00000000ec01', 2026) where iso_week = 43;
  if r.harvestable <> 3 or r.harvested_same_week <> 0 then raise exception 'FAIL: W43 Wednesday %', r; end if;
  if exists (select 1 from public.weekly_harvestable('aaaaaaaa-0000-4000-8000-00000000ec01', 2026) where iso_week <> 43)
    then raise exception 'FAIL: a W43 mark shows in another week'; end if;
end $$;

-- Friday W43, the normal walkthrough: B1 picked (Harvested), B2 still Breaker,
-- B3 not visited. Harvestable → Harvested is counted as harvested in W43.
insert into public.node_observations (organization_id, crop_id, plant_node_id, year, week_number, status, observed_at) values
  ('aaaaaaaa-0000-4000-8000-00000000e0a0', 'aaaaaaaa-0000-4000-8000-00000000ec01', 'aaaaaaaa-0000-4000-8000-00000000e301', 2026, 43, 'Harvested', pg_temp.at(43, 5)),
  ('aaaaaaaa-0000-4000-8000-00000000e0a0', 'aaaaaaaa-0000-4000-8000-00000000ec01', 'aaaaaaaa-0000-4000-8000-00000000e302', 2026, 43, 'BreakerFruit', pg_temp.at(43, 5));
insert into public.stem_visits (organization_id, crop_id, measurement_stem_id, year, week_number, observed_at) values
  ('aaaaaaaa-0000-4000-8000-00000000e0a0', 'aaaaaaaa-0000-4000-8000-00000000ec01', 'aaaaaaaa-0000-4000-8000-00000000e201', 2026, 43, pg_temp.at(43, 5));

do $$
declare r record;
begin
  select * into r from public.weekly_harvestable('aaaaaaaa-0000-4000-8000-00000000ec01', 2026) where iso_week = 43;
  if r.harvestable <> 3 or r.harvested_same_week <> 1 then raise exception 'FAIL: W43 after Friday %', r; end if;
  -- Friday's records count as they always have: B1 harvested in W43; B2's
  -- breaker week is still W42 (no new breaker, no reset); S1 only sampled.
  select * into r from public.weekly_plant_data('aaaaaaaa-0000-4000-8000-00000000ec01', 2026, pg_temp.at(43, 6)) where iso_week = 43;
  if r.sampled_stems <> 1 or r.new_breakers <> 0 or r.new_harvested <> 1 then raise exception 'FAIL: W43 weekly plant data %', r; end if;
  select * into r from public.weekly_plant_data('aaaaaaaa-0000-4000-8000-00000000ec01', 2026, pg_temp.at(43, 6)) where iso_week = 42;
  if r.new_breakers <> 3 then raise exception 'FAIL: W42 breakers changed %', r; end if;
  if (select breaker_yw from public.crop_node_stages('aaaaaaaa-0000-4000-8000-00000000ec01') where plant_node_id = 'aaaaaaaa-0000-4000-8000-00000000e302') <> 202642
    then raise exception 'FAIL: B2 breaker week reset'; end if;
end $$;

-- W44: nothing carries over; B2 and B3 are still unharvested and still Breaker.
do $$
begin
  if exists (select 1 from public.weekly_harvestable('aaaaaaaa-0000-4000-8000-00000000ec01', 2026) where iso_week = 44)
    then raise exception 'FAIL: W43 marks carried into W44'; end if;
  if (select status from public.node_latest_statuses where plant_node_id = 'aaaaaaaa-0000-4000-8000-00000000e304') <> 'BreakerFruit'
    then raise exception 'FAIL: B3 was changed'; end if;
end $$;

-- Append-only.
do $$
begin
  update public.harvestable_marks set harvestable = false;
  raise exception 'FAIL: harvestable_marks can be updated';
exception when insufficient_privilege then null;
end $$;
do $$
begin
  delete from public.harvestable_marks;
  raise exception 'FAIL: harvestable_marks can be deleted';
exception when insufficient_privilege then null;
end $$;

-- ── As a member of B: nothing of A's ─────────────────────────────────────────
select set_config('request.jwt.claims', '{"sub":"bbbbbbbb-0000-4000-8000-00000000e001","role":"authenticated"}', true);
do $$
begin
  if exists (select 1 from public.harvestable_marks) or exists (select 1 from public.weekly_harvestable('aaaaaaaa-0000-4000-8000-00000000ec01', 2026))
    then raise exception 'FAIL: B sees A''s marks'; end if;
  begin
    insert into public.harvestable_marks (organization_id, crop_id, plant_node_id, year, week_number, observed_at)
    values ('aaaaaaaa-0000-4000-8000-00000000e0a0', 'aaaaaaaa-0000-4000-8000-00000000ec01', 'aaaaaaaa-0000-4000-8000-00000000e301', 2026, 43, now());
    raise exception 'FAIL: B marked A''s pepper';
  exception when insufficient_privilege then null;
  end;
end $$;

-- ── Anonymous: no access ─────────────────────────────────────────────────────
select set_config('request.jwt.claims', '{"role":"anon"}', true);
set local role anon;
do $$
begin
  perform 1 from public.harvestable_marks;
  raise exception 'FAIL: anon can read harvestable_marks';
exception when insufficient_privilege then null;
end $$;

select '{"result": "harvestable_marks tests passed"}';
rollback;
