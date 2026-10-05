-- plant_nodes: the phone's creation time (validated), inactive parent ⇒
-- inactive shoots, the collector's direct
-- writes (replayed inserts, duplicate numbers from a second phone, discarding
-- a node), nothing else writable directly, no deletes, and the removed desktop
-- correction functions/log really gone.
--
-- Runs inside a transaction that is always rolled back, so it leaves nothing
-- behind. Any failed expectation raises and aborts the script.
--
--   npx supabase db query --linked -f supabase/tests/plant_nodes_active_test.sql
--
-- Prints a single row {"result": "plant_nodes active tests passed"} on success.

begin;

insert into auth.users (id, email, aud, role) values
  ('c0000000-0000-4000-8000-0000000000a1', 'nodes-test-a@example.invalid', 'authenticated', 'authenticated'),
  ('c0000000-0000-4000-8000-0000000000b1', 'nodes-test-b@example.invalid', 'authenticated', 'authenticated');
insert into public.organizations (id, name) values
  ('c0000000-0000-4000-8000-00000000a000', 'Nodes Org A'),
  ('c0000000-0000-4000-8000-00000000b000', 'Nodes Org B');
insert into public.organization_members (organization_id, user_id, role) values
  ('c0000000-0000-4000-8000-00000000a000', 'c0000000-0000-4000-8000-0000000000a1', 'owner'),
  ('c0000000-0000-4000-8000-00000000b000', 'c0000000-0000-4000-8000-0000000000b1', 'owner');
insert into public.crops (id, organization_id, name, color, planting_date, pullout_date, area_m2, picking_stems, created_by) values
  ('c0000000-0000-4000-8000-00000000a0c1', 'c0000000-0000-4000-8000-00000000a000', 'Crop A', 'red', '2026-01-01', '2026-12-01', 100, 100, null);
insert into public.measurement_rows (id, organization_id, crop_id, row_name, created_by) values
  ('c0000000-0000-4000-8000-00000000a0d1', 'c0000000-0000-4000-8000-00000000a000', 'c0000000-0000-4000-8000-00000000a0c1', 'Row A', null);
insert into public.measurement_stems (id, organization_id, crop_id, measurement_row_id, stem_name, created_by) values
  ('c0000000-0000-4000-8000-00000000a0e1', 'c0000000-0000-4000-8000-00000000a000', 'c0000000-0000-4000-8000-00000000a0c1', 'c0000000-0000-4000-8000-00000000a0d1', 'Stem 1', null);
insert into public.plant_nodes (id, organization_id, crop_id, measurement_stem_id, node_number, sort_order, created_by) values
  ('c0000000-0000-4000-8000-00000000a121', 'c0000000-0000-4000-8000-00000000a000', 'c0000000-0000-4000-8000-00000000a0c1', 'c0000000-0000-4000-8000-00000000a0e1', 12, 12, null);
insert into public.plant_nodes (id, organization_id, crop_id, measurement_stem_id, node_number, sort_order, is_side_shoot, parent_node_id, node_label, side, created_by) values
  ('c0000000-0000-4000-8000-00000000a122', 'c0000000-0000-4000-8000-00000000a000', 'c0000000-0000-4000-8000-00000000a0c1', 'c0000000-0000-4000-8000-00000000a0e1', 12, 12, true, 'c0000000-0000-4000-8000-00000000a121', '12+1', 'left', null);
insert into public.node_observations (organization_id, crop_id, plant_node_id, year, week_number, status, observed_at, created_by) values
  ('c0000000-0000-4000-8000-00000000a000', 'c0000000-0000-4000-8000-00000000a0c1', 'c0000000-0000-4000-8000-00000000a121', 2026, 29, 'SetFruit', '2026-07-15 12:00', null),
  ('c0000000-0000-4000-8000-00000000a000', 'c0000000-0000-4000-8000-00000000a0c1', 'c0000000-0000-4000-8000-00000000a121', 2026, 35, 'Harvested', '2026-08-26 12:00', null),
  ('c0000000-0000-4000-8000-00000000a000', 'c0000000-0000-4000-8000-00000000a0c1', 'c0000000-0000-4000-8000-00000000a122', 2026, 29, 'SetFruit', '2026-07-15 12:00', null),
  ('c0000000-0000-4000-8000-00000000a000', 'c0000000-0000-4000-8000-00000000a0c1', 'c0000000-0000-4000-8000-00000000a122', 2026, 34, 'Harvested', '2026-08-19 12:00', null);

-- ── The desktop correction infrastructure is gone ───────────────────────────
do $$
begin
  if to_regclass('public.node_corrections') is not null then raise exception 'FAIL: node_corrections still exists'; end if;
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and (p.proname in ('correct_node_renumber', 'correct_node_shoot', 'correct_node_remove', 'undo_node_correction')
                                     or p.proname like '\_correction%' or p.proname in ('_node_snapshot', '_node_identity_conflicts', '_snapshots', '_conflicts_of', '_shoot_index'))
  ) then raise exception 'FAIL: correction functions still exist'; end if;
end $$;

-- ---------------------------------------------------------------- user A
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"c0000000-0000-4000-8000-0000000000a1","role":"authenticated"}', true);

do $$
declare n int;
begin
  -- The collector's queued insert, replayed after a lost response: one record.
  insert into public.plant_nodes (id, organization_id, crop_id, measurement_stem_id, node_number, sort_order) values
    ('c0000000-0000-4000-8000-00000000a301', 'c0000000-0000-4000-8000-00000000a000', 'c0000000-0000-4000-8000-00000000a0c1', 'c0000000-0000-4000-8000-00000000a0e1', 30, 30)
    on conflict (id) do nothing;
  insert into public.plant_nodes (id, organization_id, crop_id, measurement_stem_id, node_number, sort_order) values
    ('c0000000-0000-4000-8000-00000000a301', 'c0000000-0000-4000-8000-00000000a000', 'c0000000-0000-4000-8000-00000000a0c1', 'c0000000-0000-4000-8000-00000000a0e1', 30, 30)
    on conflict (id) do nothing;
  -- A second phone's node with the same number is still accepted (no unique constraint).
  insert into public.plant_nodes (id, organization_id, crop_id, measurement_stem_id, node_number, sort_order) values
    ('c0000000-0000-4000-8000-00000000a302', 'c0000000-0000-4000-8000-00000000a000', 'c0000000-0000-4000-8000-00000000a0c1', 'c0000000-0000-4000-8000-00000000a0e1', 30, 30)
    on conflict (id) do nothing;
  select count(*) into n from public.plant_nodes where node_number = 30;
  if n <> 2 then raise exception 'FAIL: % records numbered 30 (expected 2)', n; end if;
  insert into public.plant_nodes (id, organization_id, crop_id, measurement_stem_id, node_number, sort_order, is_side_shoot, parent_node_id, node_label, side) values
    ('c0000000-0000-4000-8000-00000000a303', 'c0000000-0000-4000-8000-00000000a000', 'c0000000-0000-4000-8000-00000000a0c1', 'c0000000-0000-4000-8000-00000000a0e1', 30, 30, true, 'c0000000-0000-4000-8000-00000000a301', '30+1', 'right')
    on conflict (id) do nothing;
  insert into public.node_observations (organization_id, crop_id, plant_node_id, year, week_number, status, observed_at) values
    ('c0000000-0000-4000-8000-00000000a000', 'c0000000-0000-4000-8000-00000000a0c1', 'c0000000-0000-4000-8000-00000000a303', 2026, 40, 'Flower', now());

  -- Discarding a node (is_active = false) takes its shoots with it.
  update public.plant_nodes set is_active = false where id = 'c0000000-0000-4000-8000-00000000a301';
  if (select is_active from public.plant_nodes where id = 'c0000000-0000-4000-8000-00000000a303') then raise exception 'FAIL: shoot of an inactive node still active'; end if;
  -- Replayed from the offline queue: harmless.
  update public.plant_nodes set is_active = false where id = 'c0000000-0000-4000-8000-00000000a301';

  -- A shoot saved later under the inactive node (a phone that was offline) is kept, inactive.
  insert into public.plant_nodes (id, organization_id, crop_id, measurement_stem_id, node_number, sort_order, is_side_shoot, parent_node_id, node_label, side) values
    ('c0000000-0000-4000-8000-00000000a304', 'c0000000-0000-4000-8000-00000000a000', 'c0000000-0000-4000-8000-00000000a0c1', 'c0000000-0000-4000-8000-00000000a0e1', 30, 30, true, 'c0000000-0000-4000-8000-00000000a301', '30+2', 'left')
    on conflict (id) do nothing;
  if (select is_active from public.plant_nodes where id = 'c0000000-0000-4000-8000-00000000a304') then raise exception 'FAIL: shoot under an inactive node stored active'; end if;
  insert into public.node_observations (organization_id, crop_id, plant_node_id, year, week_number, status, observed_at) values
    ('c0000000-0000-4000-8000-00000000a000', 'c0000000-0000-4000-8000-00000000a0c1', 'c0000000-0000-4000-8000-00000000a304', 2026, 40, 'Flower', now());

  -- Nothing else is directly writable.
  begin
    update public.plant_nodes set node_number = 31 where id = 'c0000000-0000-4000-8000-00000000a302';
    raise exception 'FAIL: direct node_number update allowed';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.plant_nodes set parent_node_id = null where id = 'c0000000-0000-4000-8000-00000000a122';
    raise exception 'FAIL: direct parent update allowed';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.plant_nodes set is_active = true where id = 'c0000000-0000-4000-8000-00000000a301';
    raise exception 'FAIL: direct re-activation allowed';
  exception when insufficient_privilege then null;
  end;
  begin delete from public.plant_nodes where id = 'c0000000-0000-4000-8000-00000000a302'; raise exception 'FAIL: node delete allowed';
  exception when insufficient_privilege then null; end;
  begin delete from public.node_observations where crop_id = 'c0000000-0000-4000-8000-00000000a0c1'; raise exception 'FAIL: observation delete allowed';
  exception when insufficient_privilege then null; end;
  begin update public.node_observations set status = 'Flower' where crop_id = 'c0000000-0000-4000-8000-00000000a0c1'; raise exception 'FAIL: observation update allowed';
  exception when insufficient_privilege then null; end;
end $$;

-- ── Creation time from the phone (validated) ────────────────────────────────
do $$
declare t timestamptz;
begin
  -- Added offline five days ago, synced now: keeps the phone's time.
  insert into public.plant_nodes (id, organization_id, crop_id, measurement_stem_id, node_number, sort_order, created_at) values
    ('c0000000-0000-4000-8000-00000000a401', 'c0000000-0000-4000-8000-00000000a000', 'c0000000-0000-4000-8000-00000000a0c1', 'c0000000-0000-4000-8000-00000000a0e1', 40, 40, now() - interval '5 days')
    on conflict (id) do nothing;
  select created_at into t from public.plant_nodes where id = 'c0000000-0000-4000-8000-00000000a401';
  if t <> now() - interval '5 days' then raise exception 'FAIL: phone creation time not kept (%)', t; end if;
  -- Replayed later (lost response): still one record, still the original time.
  insert into public.plant_nodes (id, organization_id, crop_id, measurement_stem_id, node_number, sort_order, created_at) values
    ('c0000000-0000-4000-8000-00000000a401', 'c0000000-0000-4000-8000-00000000a000', 'c0000000-0000-4000-8000-00000000a0c1', 'c0000000-0000-4000-8000-00000000a0e1', 40, 40, now() - interval '5 days')
    on conflict (id) do nothing;
  if (select count(*) from public.plant_nodes where id = 'c0000000-0000-4000-8000-00000000a401') <> 1
     or (select created_at from public.plant_nodes where id = 'c0000000-0000-4000-8000-00000000a401') <> t then raise exception 'FAIL: replay changed the node'; end if;
  -- A clock running ahead is not trusted.
  insert into public.plant_nodes (id, organization_id, crop_id, measurement_stem_id, node_number, sort_order, created_at) values
    ('c0000000-0000-4000-8000-00000000a402', 'c0000000-0000-4000-8000-00000000a000', 'c0000000-0000-4000-8000-00000000a0c1', 'c0000000-0000-4000-8000-00000000a0e1', 41, 41, now() + interval '2 days');
  if (select created_at from public.plant_nodes where id = 'c0000000-0000-4000-8000-00000000a402') <> now() then raise exception 'FAIL: future creation time kept'; end if;
  -- Nor a clock reset to before the crop was planted (2026-01-01).
  insert into public.plant_nodes (id, organization_id, crop_id, measurement_stem_id, node_number, sort_order, created_at) values
    ('c0000000-0000-4000-8000-00000000a403', 'c0000000-0000-4000-8000-00000000a000', 'c0000000-0000-4000-8000-00000000a0c1', 'c0000000-0000-4000-8000-00000000a0e1', 42, 42, '2019-03-01');
  if (select created_at from public.plant_nodes where id = 'c0000000-0000-4000-8000-00000000a403') <> now() then raise exception 'FAIL: pre-planting creation time kept'; end if;
  -- Older phones / queued writes without a time: the server's time, as before.
  insert into public.plant_nodes (id, organization_id, crop_id, measurement_stem_id, node_number, sort_order) values
    ('c0000000-0000-4000-8000-00000000a404', 'c0000000-0000-4000-8000-00000000a000', 'c0000000-0000-4000-8000-00000000a0c1', 'c0000000-0000-4000-8000-00000000a0e1', 43, 43);
  if (select created_at from public.plant_nodes where id = 'c0000000-0000-4000-8000-00000000a404') <> now() then raise exception 'FAIL: default creation time'; end if;
  -- Updates never touch it.
  update public.plant_nodes set is_active = false where id = 'c0000000-0000-4000-8000-00000000a401';
  if (select created_at from public.plant_nodes where id = 'c0000000-0000-4000-8000-00000000a401') <> t then raise exception 'FAIL: update changed created_at'; end if;
end $$;

-- ── Inactive parent: the node and its shoots stop counting; history is kept ──
do $$
declare n int; before int;
begin
  select count(*) into before from public.crop_node_stages('c0000000-0000-4000-8000-00000000a0c1')
    where plant_node_id in ('c0000000-0000-4000-8000-00000000a121', 'c0000000-0000-4000-8000-00000000a122');
  if before <> 2 then raise exception 'FAIL: fixture stages %', before; end if;
  update public.plant_nodes set is_active = false where id = 'c0000000-0000-4000-8000-00000000a121';
  if (select is_active from public.plant_nodes where id = 'c0000000-0000-4000-8000-00000000a122') then raise exception 'FAIL: shoot 12+1 still active'; end if;
  select count(*) into n from public.crop_node_stages('c0000000-0000-4000-8000-00000000a0c1')
    where plant_node_id in ('c0000000-0000-4000-8000-00000000a121', 'c0000000-0000-4000-8000-00000000a122');
  if n <> 0 then raise exception 'FAIL: inactive node or its shoot still in crop_node_stages'; end if;
  select coalesce(sum(new_harvested), 0) into n from public.weekly_plant_data('c0000000-0000-4000-8000-00000000a0c1', 2026, '2026-10-05') where iso_week in (34, 35);
  if n <> 0 then raise exception 'FAIL: inactive node/shoot harvests still counted (%)', n; end if;
  select count(*) into n from public.node_observations where crop_id = 'c0000000-0000-4000-8000-00000000a0c1';
  if n <> 6 then raise exception 'FAIL: observations lost (% of 6)', n; end if;
end $$;

-- ---------------------------------------------------------------- user B
select set_config('request.jwt.claims', '{"sub":"c0000000-0000-4000-8000-0000000000b1","role":"authenticated"}', true);
do $$
begin
  update public.plant_nodes set is_active = false where id = 'c0000000-0000-4000-8000-00000000a302';
end $$;
reset role;
do $$
begin
  if not (select is_active from public.plant_nodes where id = 'c0000000-0000-4000-8000-00000000a302') then raise exception 'FAIL: B deactivated A''s node'; end if;
end $$;

select 'plant_nodes active tests passed' as result;
rollback;
