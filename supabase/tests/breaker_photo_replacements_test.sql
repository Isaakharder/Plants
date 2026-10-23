-- Breaker photo replacements and duplicate Breaker records: a replacement
-- names a photo of the same record and side and keeps it; a duplicate points
-- at another Breaker record of the same node and week; nothing is changed or
-- removed.
--
-- Runs inside a transaction that is always rolled back.
--   npx supabase db query --linked -f supabase/tests/breaker_photo_replacements_test.sql
-- Prints {"result": "breaker_photo_replacements tests passed"} on success.

begin;

insert into auth.users (id, email, aud, role) values
  ('aaaaaaaa-0000-4000-8000-00000000c701', 'bpr-test-a@example.invalid', 'authenticated', 'authenticated');
insert into public.organizations (id, name) values ('aaaaaaaa-0000-4000-8000-00000000c7a0', 'BPR Org A');
insert into public.organization_members (organization_id, user_id, role) values
  ('aaaaaaaa-0000-4000-8000-00000000c7a0', 'aaaaaaaa-0000-4000-8000-00000000c701', 'owner');
insert into public.crops (id, organization_id, name, color, planting_date, pullout_date, area_m2, picking_stems, pepper_type_id) values
  ('aaaaaaaa-0000-4000-8000-00000000c7c1', 'aaaaaaaa-0000-4000-8000-00000000c7a0', 'Crop A', 'orange', '2025-12-01', '2027-12-01', 100, 700, (select t.id from public.pepper_types t where t.organization_id = 'aaaaaaaa-0000-4000-8000-00000000c7a0' and t.key = 'bell'));
insert into public.measurement_rows (id, organization_id, crop_id, row_name) values
  ('aaaaaaaa-0000-4000-8000-00000000c711', 'aaaaaaaa-0000-4000-8000-00000000c7a0', 'aaaaaaaa-0000-4000-8000-00000000c7c1', 'Row 2');
insert into public.measurement_stems (id, organization_id, crop_id, measurement_row_id, stem_name) values
  ('aaaaaaaa-0000-4000-8000-00000000c721', 'aaaaaaaa-0000-4000-8000-00000000c7a0', 'aaaaaaaa-0000-4000-8000-00000000c7c1', 'aaaaaaaa-0000-4000-8000-00000000c711', 'Stem 4');
insert into public.plant_nodes (id, organization_id, crop_id, measurement_stem_id, node_number) values
  ('aaaaaaaa-0000-4000-8000-00000000c731', 'aaaaaaaa-0000-4000-8000-00000000c7a0', 'aaaaaaaa-0000-4000-8000-00000000c7c1', 'aaaaaaaa-0000-4000-8000-00000000c721', 1),
  ('aaaaaaaa-0000-4000-8000-00000000c732', 'aaaaaaaa-0000-4000-8000-00000000c7a0', 'aaaaaaaa-0000-4000-8000-00000000c7c1', 'aaaaaaaa-0000-4000-8000-00000000c721', 2);
-- c741: the Breaker record; c742: an accidental second one of the same node and week;
-- c743: the same node a week later; c744: another node's Breaker.
insert into public.node_observations (id, organization_id, crop_id, plant_node_id, year, week_number, status, observed_at) values
  ('aaaaaaaa-0000-4000-8000-00000000c741', 'aaaaaaaa-0000-4000-8000-00000000c7a0', 'aaaaaaaa-0000-4000-8000-00000000c7c1', 'aaaaaaaa-0000-4000-8000-00000000c731', 2026, 42, 'BreakerFruit', '2026-10-16 16:12:40Z'),
  ('aaaaaaaa-0000-4000-8000-00000000c742', 'aaaaaaaa-0000-4000-8000-00000000c7a0', 'aaaaaaaa-0000-4000-8000-00000000c7c1', 'aaaaaaaa-0000-4000-8000-00000000c731', 2026, 42, 'BreakerFruit', '2026-10-16 16:12:53Z'),
  ('aaaaaaaa-0000-4000-8000-00000000c743', 'aaaaaaaa-0000-4000-8000-00000000c7a0', 'aaaaaaaa-0000-4000-8000-00000000c7c1', 'aaaaaaaa-0000-4000-8000-00000000c731', 2026, 43, 'BreakerFruit', '2026-10-23 16:00Z'),
  ('aaaaaaaa-0000-4000-8000-00000000c744', 'aaaaaaaa-0000-4000-8000-00000000c7a0', 'aaaaaaaa-0000-4000-8000-00000000c7c1', 'aaaaaaaa-0000-4000-8000-00000000c732', 2026, 42, 'BreakerFruit', '2026-10-16 16:14Z');

create function pg_temp.photo(id uuid, obs uuid, side text, replaces uuid default null, node uuid default 'aaaaaaaa-0000-4000-8000-00000000c731')
returns void language sql as $$
  insert into public.node_photos (id, organization_id, crop_id, plant_node_id, node_observation_id, side, storage_path, content_type, bytes, sha256, taken_at, replaces_photo_id)
  values (id, 'aaaaaaaa-0000-4000-8000-00000000c7a0', 'aaaaaaaa-0000-4000-8000-00000000c7c1', node, obs, side,
          'aaaaaaaa-0000-4000-8000-00000000c7a0/aaaaaaaa-0000-4000-8000-00000000c7c1/' || node || '/' || id || '.jpg',
          'image/jpeg', 3000000, repeat('cd', 32), now(), replaces)
$$;
grant execute on function pg_temp.photo(uuid, uuid, text, uuid, uuid) to authenticated;

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-4000-8000-00000000c701","role":"authenticated"}', true);

do $$
begin
  perform pg_temp.photo('aaaaaaaa-0000-4000-8000-00000000c751', 'aaaaaaaa-0000-4000-8000-00000000c741', 'front');
  perform pg_temp.photo('aaaaaaaa-0000-4000-8000-00000000c752', 'aaaaaaaa-0000-4000-8000-00000000c741', 'back');
  perform pg_temp.photo('aaaaaaaa-0000-4000-8000-00000000c753', 'aaaaaaaa-0000-4000-8000-00000000c742', 'front');
  perform pg_temp.photo('aaaaaaaa-0000-4000-8000-00000000c754', 'aaaaaaaa-0000-4000-8000-00000000c742', 'back');
  perform pg_temp.photo('aaaaaaaa-0000-4000-8000-00000000c755', 'aaaaaaaa-0000-4000-8000-00000000c744', 'front', null, 'aaaaaaaa-0000-4000-8000-00000000c732');

  -- A replacement of the back photo: a new row; the replaced photo stays.
  perform pg_temp.photo('aaaaaaaa-0000-4000-8000-00000000c756', 'aaaaaaaa-0000-4000-8000-00000000c741', 'back', 'aaaaaaaa-0000-4000-8000-00000000c752');
  if (select count(*) from public.node_photos where node_observation_id = 'aaaaaaaa-0000-4000-8000-00000000c741') <> 3 then
    raise exception 'FAIL: a replacement removed the earlier photo';
  end if;
  -- … only of the same record and side.
  begin
    perform pg_temp.photo(gen_random_uuid(), 'aaaaaaaa-0000-4000-8000-00000000c741', 'front', 'aaaaaaaa-0000-4000-8000-00000000c752');
    raise exception 'FAIL: a front photo replaced a back photo';
  exception when check_violation then null;
  end;
  begin
    perform pg_temp.photo(gen_random_uuid(), 'aaaaaaaa-0000-4000-8000-00000000c741', 'front', 'aaaaaaaa-0000-4000-8000-00000000c753');
    raise exception 'FAIL: replaced a photo of another Breaker record';
  exception when check_violation then null;
  end;
  begin
    perform pg_temp.photo(gen_random_uuid(), 'aaaaaaaa-0000-4000-8000-00000000c741', 'front', gen_random_uuid());
    raise exception 'FAIL: replaced a photo that doesn''t exist';
  exception when check_violation or foreign_key_violation then null;
  end;

  -- The accidental second record is marked a duplicate of the first: a correction row only.
  insert into public.photo_pair_corrections (organization_id, crop_id, node_observation_id, kind, duplicate_of_observation_id, note)
  values ('aaaaaaaa-0000-4000-8000-00000000c7a0', 'aaaaaaaa-0000-4000-8000-00000000c7c1', 'aaaaaaaa-0000-4000-8000-00000000c742', 'duplicate',
          'aaaaaaaa-0000-4000-8000-00000000c741', 'reopened the photo step by accident');
  if (select count(*) from public.node_observations where plant_node_id = 'aaaaaaaa-0000-4000-8000-00000000c731') <> 3
     or (select count(*) from public.node_photos where node_observation_id = 'aaaaaaaa-0000-4000-8000-00000000c742') <> 2 then
    raise exception 'FAIL: marking a duplicate changed records or photos';
  end if;
  -- The kept record can't then be marked a duplicate of the one marked (one record stays in use).
  begin
    insert into public.photo_pair_corrections (organization_id, crop_id, node_observation_id, kind, duplicate_of_observation_id)
    values ('aaaaaaaa-0000-4000-8000-00000000c7a0', 'aaaaaaaa-0000-4000-8000-00000000c7c1', 'aaaaaaaa-0000-4000-8000-00000000c741', 'duplicate', 'aaaaaaaa-0000-4000-8000-00000000c742');
    raise exception 'FAIL: both records marked duplicates of each other';
  exception when check_violation then null;
  end;
  -- … only of another Breaker record of the same node and week.
  begin
    insert into public.photo_pair_corrections (organization_id, crop_id, node_observation_id, kind, duplicate_of_observation_id)
    values ('aaaaaaaa-0000-4000-8000-00000000c7a0', 'aaaaaaaa-0000-4000-8000-00000000c7c1', 'aaaaaaaa-0000-4000-8000-00000000c742', 'duplicate', 'aaaaaaaa-0000-4000-8000-00000000c742');
    raise exception 'FAIL: a record marked a duplicate of itself';
  exception when check_violation then null;
  end;
  begin
    insert into public.photo_pair_corrections (organization_id, crop_id, node_observation_id, kind, duplicate_of_observation_id)
    values ('aaaaaaaa-0000-4000-8000-00000000c7a0', 'aaaaaaaa-0000-4000-8000-00000000c7c1', 'aaaaaaaa-0000-4000-8000-00000000c742', 'duplicate', 'aaaaaaaa-0000-4000-8000-00000000c743');
    raise exception 'FAIL: a duplicate of another week''s record';
  exception when check_violation then null;
  end;
  begin
    insert into public.photo_pair_corrections (organization_id, crop_id, node_observation_id, kind, duplicate_of_observation_id)
    values ('aaaaaaaa-0000-4000-8000-00000000c7a0', 'aaaaaaaa-0000-4000-8000-00000000c7c1', 'aaaaaaaa-0000-4000-8000-00000000c742', 'duplicate', 'aaaaaaaa-0000-4000-8000-00000000c744');
    raise exception 'FAIL: a duplicate of another node''s record';
  exception when check_violation then null;
  end;
  begin
    insert into public.photo_pair_corrections (organization_id, crop_id, node_observation_id, kind)
    values ('aaaaaaaa-0000-4000-8000-00000000c7a0', 'aaaaaaaa-0000-4000-8000-00000000c7c1', 'aaaaaaaa-0000-4000-8000-00000000c742', 'duplicate');
    raise exception 'FAIL: a duplicate without the record it duplicates';
  exception when check_violation then null;
  end;
  begin
    insert into public.photo_pair_corrections (organization_id, crop_id, node_observation_id, kind, duplicate_of_observation_id)
    values ('aaaaaaaa-0000-4000-8000-00000000c7a0', 'aaaaaaaa-0000-4000-8000-00000000c7c1', 'aaaaaaaa-0000-4000-8000-00000000c742', 'unusable', 'aaaaaaaa-0000-4000-8000-00000000c741');
    raise exception 'FAIL: an unusable mark carrying a duplicate link';
  exception when check_violation then null;
  end;
  -- Restoring is still a new row; the duplicate mark stays in the history.
  insert into public.photo_pair_corrections (organization_id, crop_id, node_observation_id, kind)
  values ('aaaaaaaa-0000-4000-8000-00000000c7a0', 'aaaaaaaa-0000-4000-8000-00000000c7c1', 'aaaaaaaa-0000-4000-8000-00000000c742', 'restore');
  if (select count(*) from public.photo_pair_corrections where node_observation_id = 'aaaaaaaa-0000-4000-8000-00000000c742') <> 2 then
    raise exception 'FAIL: restoring removed the duplicate mark';
  end if;
end $$;

-- Append-only, as before.
do $$
begin
  update public.node_photos set replaces_photo_id = null;
  raise exception 'FAIL: a replacement link can be changed';
exception when insufficient_privilege then null;
end $$;

reset role;
select 'breaker_photo_replacements tests passed' as result;
rollback;
