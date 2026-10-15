-- Breaker photos: binding to a BreakerFruit observation of the same node,
-- identity captured at insert, previews in the photo's own folder,
-- append-only records, corrections that never overwrite or move
-- observations, RLS, and (where Supabase Storage exists) the private
-- bucket's policies.
--
-- Runs inside a transaction that is always rolled back.
--   npx supabase db query --linked -f supabase/tests/breaker_photos_test.sql
-- Prints {"result": "breaker_photos tests passed"} on success.

begin;

insert into auth.users (id, email, aud, role) values
  ('aaaaaaaa-0000-4000-8000-00000000b701', 'bp-test-a@example.invalid', 'authenticated', 'authenticated'),
  ('bbbbbbbb-0000-4000-8000-00000000b701', 'bp-test-b@example.invalid', 'authenticated', 'authenticated');
insert into public.organizations (id, name) values
  ('aaaaaaaa-0000-4000-8000-00000000b7a0', 'BP Org A'),
  ('bbbbbbbb-0000-4000-8000-00000000b7b0', 'BP Org B');
insert into public.organization_members (organization_id, user_id, role) values
  ('aaaaaaaa-0000-4000-8000-00000000b7a0', 'aaaaaaaa-0000-4000-8000-00000000b701', 'owner'),
  ('bbbbbbbb-0000-4000-8000-00000000b7b0', 'bbbbbbbb-0000-4000-8000-00000000b701', 'owner');
insert into public.crops (id, organization_id, name, color, planting_date, pullout_date, area_m2, picking_stems) values
  ('aaaaaaaa-0000-4000-8000-00000000b7c1', 'aaaaaaaa-0000-4000-8000-00000000b7a0', 'Crop A', 'orange', '2025-12-01', '2027-12-01', 100, 700),
  ('aaaaaaaa-0000-4000-8000-00000000b7c2', 'aaaaaaaa-0000-4000-8000-00000000b7a0', 'Crop A2', 'red', '2025-12-01', '2027-12-01', 100, 700);
insert into public.measurement_rows (id, organization_id, crop_id, row_name) values
  ('aaaaaaaa-0000-4000-8000-00000000b711', 'aaaaaaaa-0000-4000-8000-00000000b7a0', 'aaaaaaaa-0000-4000-8000-00000000b7c1', 'Row 7'),
  ('aaaaaaaa-0000-4000-8000-00000000b712', 'aaaaaaaa-0000-4000-8000-00000000b7a0', 'aaaaaaaa-0000-4000-8000-00000000b7c2', 'Row 9');
insert into public.measurement_stems (id, organization_id, crop_id, measurement_row_id, stem_name) values
  ('aaaaaaaa-0000-4000-8000-00000000b721', 'aaaaaaaa-0000-4000-8000-00000000b7a0', 'aaaaaaaa-0000-4000-8000-00000000b7c1', 'aaaaaaaa-0000-4000-8000-00000000b711', 'S1'),
  ('aaaaaaaa-0000-4000-8000-00000000b722', 'aaaaaaaa-0000-4000-8000-00000000b7a0', 'aaaaaaaa-0000-4000-8000-00000000b7c2', 'aaaaaaaa-0000-4000-8000-00000000b712', 'S9');
insert into public.plant_nodes (id, organization_id, crop_id, measurement_stem_id, node_number) values
  ('aaaaaaaa-0000-4000-8000-00000000b731', 'aaaaaaaa-0000-4000-8000-00000000b7a0', 'aaaaaaaa-0000-4000-8000-00000000b7c1', 'aaaaaaaa-0000-4000-8000-00000000b721', 12),
  ('aaaaaaaa-0000-4000-8000-00000000b732', 'aaaaaaaa-0000-4000-8000-00000000b7a0', 'aaaaaaaa-0000-4000-8000-00000000b7c1', 'aaaaaaaa-0000-4000-8000-00000000b721', 13),
  ('aaaaaaaa-0000-4000-8000-00000000b733', 'aaaaaaaa-0000-4000-8000-00000000b7a0', 'aaaaaaaa-0000-4000-8000-00000000b7c2', 'aaaaaaaa-0000-4000-8000-00000000b722', 4);
insert into public.node_observations (id, organization_id, crop_id, plant_node_id, year, week_number, status, observed_at) values
  ('aaaaaaaa-0000-4000-8000-00000000b741', 'aaaaaaaa-0000-4000-8000-00000000b7a0', 'aaaaaaaa-0000-4000-8000-00000000b7c1', 'aaaaaaaa-0000-4000-8000-00000000b731', 2026, 42, 'BreakerFruit', '2026-10-16 14:00Z'),
  ('aaaaaaaa-0000-4000-8000-00000000b742', 'aaaaaaaa-0000-4000-8000-00000000b7a0', 'aaaaaaaa-0000-4000-8000-00000000b7c1', 'aaaaaaaa-0000-4000-8000-00000000b732', 2026, 42, 'MatureGreen', '2026-10-16 14:00Z');

create function pg_temp.path(node uuid, id uuid, suffix text default '.jpg') returns text language sql as $$
  select 'aaaaaaaa-0000-4000-8000-00000000b7a0/aaaaaaaa-0000-4000-8000-00000000b7c1/' || node || '/' || id || suffix
$$;
-- A photo row as the app sends it (identity columns are filled in by the trigger).
create function pg_temp.photo(id uuid, node uuid, obs uuid, side text, preview text default null, org uuid default 'aaaaaaaa-0000-4000-8000-00000000b7a0')
returns void language sql as $$
  insert into public.node_photos (id, organization_id, crop_id, plant_node_id, node_observation_id, side, storage_path, preview_path, content_type, bytes, width, height, sha256, taken_at, capture_meta)
  values (id, org, 'aaaaaaaa-0000-4000-8000-00000000b7c1', node, obs, side, pg_temp.path(node, id), preview, 'image/jpeg', 2400000, 3024, 4032,
          repeat('ab', 32), '2026-10-16 14:00:05Z', '{"app": "test", "source": "camera"}')
$$;
grant execute on function pg_temp.path(uuid, uuid, text) to authenticated;
grant execute on function pg_temp.photo(uuid, uuid, uuid, text, text, uuid) to authenticated;

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-4000-8000-00000000b701","role":"authenticated"}', true);

do $$
declare r record;
begin
  perform pg_temp.photo('aaaaaaaa-0000-4000-8000-00000000b751', 'aaaaaaaa-0000-4000-8000-00000000b731', 'aaaaaaaa-0000-4000-8000-00000000b741', 'front',
                        pg_temp.path('aaaaaaaa-0000-4000-8000-00000000b731', 'aaaaaaaa-0000-4000-8000-00000000b751', '.preview.jpg'));
  perform pg_temp.photo('aaaaaaaa-0000-4000-8000-00000000b752', 'aaaaaaaa-0000-4000-8000-00000000b731', 'aaaaaaaa-0000-4000-8000-00000000b741', 'back');
  select * into r from public.node_photos where id = 'aaaaaaaa-0000-4000-8000-00000000b751';
  if r.measurement_stem_id <> 'aaaaaaaa-0000-4000-8000-00000000b721' or r.measurement_row_id <> 'aaaaaaaa-0000-4000-8000-00000000b711'
     or r.node_number <> 12 or r.is_side_shoot or r.target_colour <> 'orange' or r.year <> 2026 or r.week_number <> 42
     or r.created_by <> 'aaaaaaaa-0000-4000-8000-00000000b701' or r.capture_meta ->> 'source' <> 'camera' then
    raise exception 'FAIL: identity at capture %', r;
  end if;

  -- The observation must be this node's, and a BreakerFruit record.
  begin
    perform pg_temp.photo(gen_random_uuid(), 'aaaaaaaa-0000-4000-8000-00000000b732', 'aaaaaaaa-0000-4000-8000-00000000b741', 'front');
    raise exception 'FAIL: photo attached to another node''s observation';
  exception when check_violation then null;
  end;
  begin
    perform pg_temp.photo(gen_random_uuid(), 'aaaaaaaa-0000-4000-8000-00000000b732', 'aaaaaaaa-0000-4000-8000-00000000b742', 'front');
    raise exception 'FAIL: photo of a MatureGreen record';
  exception when check_violation then null;
  end;
  -- Original and preview must be in the photo's own folder.
  begin
    perform pg_temp.photo('aaaaaaaa-0000-4000-8000-00000000b753', 'aaaaaaaa-0000-4000-8000-00000000b731', 'aaaaaaaa-0000-4000-8000-00000000b741', 'front',
                          pg_temp.path('aaaaaaaa-0000-4000-8000-00000000b731', 'aaaaaaaa-0000-4000-8000-00000000b751', '.preview.jpg'));
    raise exception 'FAIL: another photo''s preview accepted';
  exception when check_violation then null;
  end;

  -- A retried upload with the same id never makes a second row.
  insert into public.node_photos (id, organization_id, crop_id, plant_node_id, node_observation_id, side, storage_path, content_type, bytes, sha256, taken_at)
  values ('aaaaaaaa-0000-4000-8000-00000000b751', 'aaaaaaaa-0000-4000-8000-00000000b7a0', 'aaaaaaaa-0000-4000-8000-00000000b7c1', 'aaaaaaaa-0000-4000-8000-00000000b731',
          'aaaaaaaa-0000-4000-8000-00000000b741', 'front', pg_temp.path('aaaaaaaa-0000-4000-8000-00000000b731', 'aaaaaaaa-0000-4000-8000-00000000b751'),
          'image/jpeg', 2400000, repeat('ab', 32), now())
  on conflict (id) do nothing;
  if (select count(*) from public.node_photos) <> 2 then raise exception 'FAIL: retry made a duplicate'; end if;

  -- Manual colour estimates and corrections: corrections supersede, never overwrite.
  insert into public.photo_colour_analyses (id, organization_id, crop_id, node_observation_id, front_photo_id, back_photo_id, kind, method, model_version, target_colour, front_percent, back_percent, combined_percent)
  values ('aaaaaaaa-0000-4000-8000-00000000b761', 'aaaaaaaa-0000-4000-8000-00000000b7a0', 'aaaaaaaa-0000-4000-8000-00000000b7c1', 'aaaaaaaa-0000-4000-8000-00000000b741',
          'aaaaaaaa-0000-4000-8000-00000000b751', 'aaaaaaaa-0000-4000-8000-00000000b752', 'manual', 'visual-estimate', 'v1', 'orange', 30, 10, 20);
  insert into public.photo_colour_analyses (organization_id, crop_id, node_observation_id, kind, method, model_version, target_colour, combined_percent, supersedes_id, note)
  values ('aaaaaaaa-0000-4000-8000-00000000b7a0', 'aaaaaaaa-0000-4000-8000-00000000b7c1', 'aaaaaaaa-0000-4000-8000-00000000b741', 'correction', 'visual-estimate', 'v1', 'orange', 25,
          'aaaaaaaa-0000-4000-8000-00000000b761', 'back photo was in shade');
  if (select count(*) from public.photo_colour_analyses) <> 2 then raise exception 'FAIL: correction overwrote the original'; end if;
  begin
    insert into public.photo_colour_analyses (organization_id, crop_id, node_observation_id, kind, method, model_version, target_colour, combined_percent)
    values ('aaaaaaaa-0000-4000-8000-00000000b7a0', 'aaaaaaaa-0000-4000-8000-00000000b7c1', 'aaaaaaaa-0000-4000-8000-00000000b741', 'automatic', 'x', 'v1', 'orange', 25);
    raise exception 'FAIL: a member wrote an automatic analysis';
  exception when insufficient_privilege then null;
  end;

  -- Node reassignment: a correction row only. Photos, observations and stages are untouched.
  insert into public.photo_pair_corrections (organization_id, crop_id, node_observation_id, kind, corrected_node_id, note)
  values ('aaaaaaaa-0000-4000-8000-00000000b7a0', 'aaaaaaaa-0000-4000-8000-00000000b7c1', 'aaaaaaaa-0000-4000-8000-00000000b741', 'reassign_node',
          'aaaaaaaa-0000-4000-8000-00000000b732', 'pepper in the photo hangs on node 13');
  if (select count(*) from public.node_photos where plant_node_id = 'aaaaaaaa-0000-4000-8000-00000000b731') <> 2
     or (select count(*) from public.node_observations where crop_id = 'aaaaaaaa-0000-4000-8000-00000000b7c1') <> 2 then
    raise exception 'FAIL: a reassignment changed photos or observations';
  end if;
  -- … only to a node of the same crop, and only for an observation that has photos.
  begin
    insert into public.photo_pair_corrections (organization_id, crop_id, node_observation_id, kind, corrected_node_id)
    values ('aaaaaaaa-0000-4000-8000-00000000b7a0', 'aaaaaaaa-0000-4000-8000-00000000b7c1', 'aaaaaaaa-0000-4000-8000-00000000b741', 'reassign_node', 'aaaaaaaa-0000-4000-8000-00000000b733');
    raise exception 'FAIL: reassigned to another crop''s node';
  exception when foreign_key_violation then null;
  end;
  begin
    insert into public.photo_pair_corrections (organization_id, crop_id, node_observation_id, kind)
    values ('aaaaaaaa-0000-4000-8000-00000000b7a0', 'aaaaaaaa-0000-4000-8000-00000000b7c1', 'aaaaaaaa-0000-4000-8000-00000000b742', 'unusable');
    raise exception 'FAIL: corrected an observation without photos';
  exception when check_violation then null;
  end;
  begin
    insert into public.photo_pair_corrections (organization_id, crop_id, node_observation_id, kind)
    values ('aaaaaaaa-0000-4000-8000-00000000b7a0', 'aaaaaaaa-0000-4000-8000-00000000b7c1', 'aaaaaaaa-0000-4000-8000-00000000b741', 'reassign_node');
    raise exception 'FAIL: reassignment without a node';
  exception when check_violation then null;
  end;
end $$;

-- Append-only.
do $$
begin
  update public.node_photos set side = 'back';
  raise exception 'FAIL: photos can be changed';
exception when insufficient_privilege then null;
end $$;
do $$
begin
  delete from public.photo_pair_corrections;
  raise exception 'FAIL: corrections can be deleted';
exception when insufficient_privilege then null;
end $$;
do $$
begin
  delete from public.photo_colour_analyses;
  raise exception 'FAIL: analyses can be deleted';
exception when insufficient_privilege then null;
end $$;

-- Storage policies (only where Supabase Storage, or its local stand-in, exists).
do $$
declare n integer;
begin
  if to_regclass('storage.objects') is null then return; end if;
  if (select public from storage.buckets where id = 'node-photos') then raise exception 'FAIL: node-photos is public'; end if;
  -- A member may add an object in the organization's folder…
  insert into storage.objects (bucket_id, name) values ('node-photos', pg_temp.path('aaaaaaaa-0000-4000-8000-00000000b731', 'aaaaaaaa-0000-4000-8000-00000000b751'));
  -- … but not in another organization's folder, nor outside any organization (refused, never an error).
  begin
    insert into storage.objects (bucket_id, name) values ('node-photos', 'bbbbbbbb-0000-4000-8000-00000000b7b0/x/y/z.jpg');
    raise exception 'FAIL: wrote into another organization''s folder';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into storage.objects (bucket_id, name) values ('node-photos', 'not-an-id/x.jpg');
    raise exception 'FAIL: wrote outside an organization folder';
  exception when insufficient_privilege then null;
  end;
  -- Nobody overwrites or deletes stored photos through the API.
  update storage.objects set name = name || 'x' where bucket_id = 'node-photos';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL: a stored photo was renamed'; end if;
  -- No delete policy: 0 rows. (Real Supabase also refuses any direct delete from storage tables.)
  begin
    delete from storage.objects where bucket_id = 'node-photos';
    get diagnostics n = row_count;
    if n <> 0 then raise exception 'FAIL: a stored photo was deleted'; end if;
  exception when insufficient_privilege then
    null; -- Supabase's storage.protect_delete(): direct deletes are refused outright.
  end;
  if (select count(*) from storage.objects where bucket_id = 'node-photos') <> 1 then raise exception 'FAIL: own photo not readable'; end if;
end $$;

-- Another organization sees nothing and can't attach photos to A's nodes.
select set_config('request.jwt.claims', '{"sub":"bbbbbbbb-0000-4000-8000-00000000b701","role":"authenticated"}', true);
do $$
begin
  if exists (select 1 from public.node_photos) or exists (select 1 from public.photo_colour_analyses) or exists (select 1 from public.photo_pair_corrections) then
    raise exception 'FAIL: B sees A''s photos';
  end if;
  if to_regclass('storage.objects') is not null then
    -- Dynamic SQL: where Supabase Storage isn't installed, storage.objects can't even be parsed.
    execute 'select exists (select 1 from storage.objects where bucket_id = ''node-photos'')' into found;
    if found then raise exception 'FAIL: B sees A''s stored photos'; end if;
  end if;
  perform pg_temp.photo(gen_random_uuid(), 'aaaaaaaa-0000-4000-8000-00000000b731', 'aaaaaaaa-0000-4000-8000-00000000b741', 'front');
  raise exception 'FAIL: B added a photo to A''s node';
exception when insufficient_privilege then null;
end $$;

-- anon: nothing.
reset role;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
set local role anon;
do $$
begin
  perform 1 from public.node_photos;
  raise exception 'FAIL: anon can read photos';
exception when insufficient_privilege then null;
end $$;

reset role;
select 'breaker_photos tests passed' as result;
rollback;
