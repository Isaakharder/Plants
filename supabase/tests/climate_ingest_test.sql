-- 20261027000000_climate_ingest: climate sources, agent keys, the ingest
-- function (original bytes kept, duplicates, same-hour conflicts, quarantine),
-- append-only history, privacy between organizations, and effective-dated
-- planting ↔ zone assignments with zone isolation.
--
-- Runs inside a transaction that is always rolled back.
--   npx supabase db query --linked -f supabase/tests/climate_ingest_test.sql
-- Prints {"result": "climate_ingest tests passed"} on success.

begin;

insert into auth.users (id, email, aud, role) values
  ('aaaaaaaa-0000-4000-8000-0000000c1001', 'clim-a@example.invalid', 'authenticated', 'authenticated'),
  ('aaaaaaaa-0000-4000-8000-0000000c1002', 'clim-a-member@example.invalid', 'authenticated', 'authenticated'),
  ('bbbbbbbb-0000-4000-8000-0000000c1001', 'clim-b@example.invalid', 'authenticated', 'authenticated');
insert into public.organizations (id, name) values
  ('aaaaaaaa-0000-4000-8000-0000000c10a0', 'Climate Org A'),
  ('bbbbbbbb-0000-4000-8000-0000000c10b0', 'Climate Org B');
insert into public.organization_members (organization_id, user_id, role) values
  ('aaaaaaaa-0000-4000-8000-0000000c10a0', 'aaaaaaaa-0000-4000-8000-0000000c1001', 'owner'),
  ('aaaaaaaa-0000-4000-8000-0000000c10a0', 'aaaaaaaa-0000-4000-8000-0000000c1002', 'member'),
  ('bbbbbbbb-0000-4000-8000-0000000c10b0', 'bbbbbbbb-0000-4000-8000-0000000c1001', 'owner');
insert into public.crops (id, organization_id, name, color, planting_date, pullout_date, area_m2, picking_stems) values
  ('aaaaaaaa-0000-4000-8000-0000000c1c01', 'aaaaaaaa-0000-4000-8000-0000000c10a0', 'Silverstone', 'red', '2025-12-01', '2026-12-01', 1000, 700);

create temporary table t (k text primary key, v text) on commit drop;
grant all on t to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Owner creates the source and an agent key; the key is shown once, only its hash is kept.
-- ---------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-4000-8000-0000000c1001","role":"authenticated"}', true);
do $$
declare
  s public.climate_sources;
  k jsonb;
begin
  s := public.climate_create_source('aaaaaaaa-0000-4000-8000-0000000c10a0', 'Synopta');
  if s.time_zone <> 'America/Toronto' then raise exception 'FAIL: default time zone %', s.time_zone; end if;
  k := public.climate_create_agent_key(s.id, 'Climate PC');
  if k->>'key' !~ '^plk_[0-9a-f]{10}_[0-9a-f]{64}$' then raise exception 'FAIL: key format %', k; end if;
  insert into t values ('source', s.id), ('key', k->>'key'), ('key_id', k->>'id');
  if not exists (select 1 from public.climate_agent_keys where id = (k->>'id')::uuid and last_used_at is null) then
    raise exception 'FAIL: owner can''t see the key''s details';
  end if;
end $$;
do $$
begin
  perform key_hash from public.climate_agent_keys;
  raise exception 'FAIL: the key hash is readable from the app';
exception when insufficient_privilege then null;
end $$;
do $$
begin
  perform public.climate_ingest_file(null, 'agent', null, null, 'x', '', '', null, '{}');
  raise exception 'FAIL: the app can call the ingest function';
exception when insufficient_privilege then null;
end $$;

-- A member (not owner) can't create keys.
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-4000-8000-0000000c1002","role":"authenticated"}', true);
do $$
begin
  perform public.climate_create_agent_key((select v::uuid from t where k = 'source'), 'Nope');
  raise exception 'FAIL: a member created an agent key';
exception when insufficient_privilege then null;
end $$;
reset role;

-- ---------------------------------------------------------------------------
-- Authentication (server)
-- ---------------------------------------------------------------------------
set local role service_role;
do $$
declare
  a jsonb;
begin
  a := public.climate_agent_authenticate((select v from t where k = 'key'), '203.0.113.5');
  if a->>'source_id' <> (select v from t where k = 'source') or a->>'organization_name' <> 'Climate Org A' then raise exception 'FAIL: auth %', a; end if;
  if public.climate_agent_authenticate('plk_0000000000_' || repeat('0', 64), null) is not null then raise exception 'FAIL: an unknown key authenticated'; end if;
  if public.climate_agent_authenticate('not a key', null) is not null then raise exception 'FAIL: garbage authenticated'; end if;
end $$;
reset role;
do $$
begin
  if (select last_used_ip from public.climate_agent_keys where id = (select v::uuid from t where k = 'key_id')) <> '203.0.113.5' then
    raise exception 'FAIL: key use not recorded';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Ingest
-- ---------------------------------------------------------------------------
-- A parsed file for 2026-10-17 10:00 Toronto (14:00 UTC): Zones 1–3, three metrics.
insert into t values ('parsed', jsonb_build_object(
  'parserVersion', 'synopta-block-summary/1', 'encoding', 'windows-1252', 'status', 'parsed',
  'problems', '[]'::jsonb, 'warnings', '[]'::jsonb,
  'zones', '[{"label":"Zone 1","column":1},{"label":"Zone 2","column":2},{"label":"Zone 3","column":3}]'::jsonb,
  'readings', '[
     {"zone":"Zone 1","row_label":"Air temperature [°C]","metric":"air_temperature","unit":"°C","unit_raw":"°C","raw_text":"20.3","value":20.3,"flags":[]},
     {"zone":"Zone 2","row_label":"Air temperature [°C]","metric":"air_temperature","unit":"°C","unit_raw":"°C","raw_text":"21.9","value":21.9,"flags":[]},
     {"zone":"Zone 3","row_label":"Air temperature [°C]","metric":"air_temperature","unit":"°C","unit_raw":"°C","raw_text":"22.1","value":22.1,"flags":[]},
     {"zone":"Zone 1","row_label":"Average pH","metric":"ph","unit":"pH","unit_raw":null,"raw_text":"0.0","value":0,"flags":["ph_zero_sentinel"]}
   ]'::jsonb,
  'meta', '{"systemDateRaw":"10/17/2026","systemTimeRaw":"Real time - 10:00","weekNumberRaw":"42"}'::jsonb,
  'time', '{"filenameLocal":"2026-10-17 10:00:09","method":"filename","hourLocal":"2026-10-17 10:00:00","hourUtc":"2026-10-17T14:00:00.000Z","dateOrder":"MDY","clockOffsetMinutes":0}'::jsonb)::text);

set local role service_role;
do $$
declare
  src uuid := (select v::uuid from t where k = 'source');
  kid uuid := (select v::uuid from t where k = 'key_id');
  p jsonb := (select v::jsonb from t where k = 'parsed');
  raw1 bytea := convert_to('file one', 'UTF8');
  raw2 bytea := convert_to('file two, same hour', 'UTF8');
  r jsonb;
begin
  -- New file.
  r := public.climate_ingest_file(src, 'agent', kid, null, 'Block Summary_20261017_100009.csv',
         encode(raw1, 'base64'), encode(sha256(raw1), 'hex'), '2.0.0', p);
  if r->>'status' <> 'created' or (r->>'readings')::int <> 4 or (r->>'hour_utc')::timestamptz <> '2026-10-17 14:00+00' then raise exception 'FAIL: created %', r; end if;
  insert into t values ('file1', r->>'import_id');

  -- The same bytes again (agent retry or a manual re-upload): duplicate, nothing new stored.
  r := public.climate_ingest_file(src, 'agent', kid, null, 'Block Summary_20261017_100009.csv',
         encode(raw1, 'base64'), encode(sha256(raw1), 'hex'), '2.0.0', p);
  if r->>'status' <> 'duplicate' or r->>'import_id' <> (select v from t where k = 'file1') then raise exception 'FAIL: duplicate %', r; end if;

  -- A different file (different readings) for the same hour: kept as a conflict for review, the first stays in effect.
  -- (Different bytes with the same readings are a duplicate: climate_content_duplicates_test.sql.)
  r := public.climate_ingest_file(src, 'agent', kid, null, 'Block Summary_20261017_100009 (2).csv',
         encode(raw2, 'base64'), encode(sha256(raw2), 'hex'), '2.0.0',
         jsonb_set(jsonb_set(p, '{readings,1,raw_text}', '"22.0"'), '{readings,1,value}', '22.0'));
  if r->>'status' <> 'conflict' or r->>'file_status' <> 'conflict' then raise exception 'FAIL: conflict %', r; end if;
  insert into t values ('file2', r->>'import_id');

  -- Bytes that don't match the hash are refused.
  begin
    perform public.climate_ingest_file(src, 'agent', kid, null, 'x.csv', encode(raw1, 'base64'), repeat('0', 64), null, p);
    raise exception 'FAIL: a hash mismatch was stored';
  exception when invalid_parameter_value then null;
  end;

  -- A quarantined file: original bytes kept, no hour, no readings; its zones are still discovered.
  r := public.climate_ingest_file(src, 'agent', kid, null, '080003.csv',
         encode(convert_to('quarantined bytes', 'UTF8'), 'base64'), encode(sha256(convert_to('quarantined bytes', 'UTF8')), 'hex'), null,
         jsonb_build_object('parserVersion', 'synopta-block-summary/1', 'status', 'quarantined',
           'problems', '[{"code":"ambiguous_system_date","message":"…"}]'::jsonb,
           'zones', '[{"label":"Zone 1","column":1},{"label":"Zone 23","column":23}]'::jsonb,
           'readings', '[]'::jsonb, 'meta', '{}'::jsonb, 'time', '{"hourUtc":null}'::jsonb));
  if r->>'status' <> 'quarantined' or r->>'file_status' <> 'none' then raise exception 'FAIL: quarantined %', r; end if;
  insert into t values ('file3', r->>'import_id');

  -- A key for another source, or a manual upload by a non-owner, is refused.
  begin
    perform public.climate_ingest_file(src, 'agent', gen_random_uuid(), null, 'y.csv', encode(raw1, 'base64'), encode(sha256(raw1), 'hex'), null, p);
    raise exception 'FAIL: an unknown key ingested';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.climate_ingest_file(src, 'manual', null, 'aaaaaaaa-0000-4000-8000-0000000c1002', 'y.csv', encode(raw1, 'base64'), encode(sha256(raw1), 'hex'), null, p);
    raise exception 'FAIL: a member imported';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

do $$
declare
  f1 public.climate_import_files;
  f3 public.climate_import_files;
begin
  select * into f1 from public.climate_import_files where id = (select v::uuid from t where k = 'file1');
  if convert_from(f1.raw_bytes, 'UTF8') <> 'file one' or f1.byte_size <> 8 or f1.hour_state <> 'active' or f1.channel <> 'agent'
     or f1.agent_version <> '2.0.0' or f1.system_date_raw <> '10/17/2026' or f1.date_order <> 'MDY' then
    raise exception 'FAIL: file 1 stored as %', f1;
  end if;
  select * into f3 from public.climate_import_files where id = (select v::uuid from t where k = 'file3');
  if convert_from(f3.raw_bytes, 'UTF8') <> 'quarantined bytes' or f3.hour_utc is not null or f3.problems->0->>'code' <> 'ambiguous_system_date' then
    raise exception 'FAIL: quarantined file stored as %', f3;
  end if;
  if (select count(*) from public.climate_import_files) <> 3 then raise exception 'FAIL: % files', (select count(*) from public.climate_import_files); end if;
  if exists (select 1 from public.climate_readings where file_id = f3.id) then raise exception 'FAIL: a quarantined file has readings'; end if;
  -- Readings: original text, flags; only the active file's in the active view.
  if (select raw_text from public.climate_readings where file_id = f1.id and metric = 'ph') <> '0.0'
     or not (select 'ph_zero_sentinel' = any(flags) from public.climate_readings where file_id = f1.id and metric = 'ph') then
    raise exception 'FAIL: pH reading';
  end if;
  -- The active view holds the six measurements only (20261031): Zones 1–3 temperature; the stored pH reading is kept but not used.
  if (select count(*) from public.climate_readings_active) <> 3 then raise exception 'FAIL: active view counts % readings', (select count(*) from public.climate_readings_active); end if;
  if (select count(*) from public.climate_readings) <> 8 then raise exception 'FAIL: conflict file''s readings not kept'; end if;
  -- Zones: discovered by label, including Zone 23 from the quarantined header; seen hours only from the active file.
  if (select string_agg(source_label || ':' || zone_number, ',' order by zone_number) from public.climate_zones) <> 'Zone 1:1,Zone 2:2,Zone 3:3,Zone 23:23' then
    raise exception 'FAIL: zones %', (select string_agg(source_label, ',') from public.climate_zones);
  end if;
  if (select first_seen_hour from public.climate_zones where source_label = 'Zone 2') <> '2026-10-17 14:00+00'
     or (select last_seen_hour from public.climate_zones where source_label = 'Zone 23') is not null then
    raise exception 'FAIL: zone seen hours';
  end if;
  -- Attempts log.
  if (select string_agg(outcome, ',' order by id) from public.climate_import_attempts) <> 'created,duplicate,conflict,quarantined' then
    raise exception 'FAIL: attempts %', (select string_agg(outcome, ',' order by id) from public.climate_import_attempts);
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- History can't be changed
-- ---------------------------------------------------------------------------
do $$
begin
  begin
    update public.climate_readings set value = 1;
    raise exception 'FAIL: a reading changed';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.climate_import_files set raw_bytes = 'x' where id = (select v::uuid from t where k = 'file1');
    raise exception 'FAIL: original bytes changed';
  exception when insufficient_privilege then null;
  end;
  begin
    delete from public.climate_import_files where id = (select v::uuid from t where k = 'file3');
    raise exception 'FAIL: a file was deleted';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.climate_zones set source_label = 'Zone 99' where source_label = 'Zone 1';
    raise exception 'FAIL: a zone label changed';
  exception when insufficient_privilege then null;
  end;
  begin
    delete from public.climate_import_attempts;
    raise exception 'FAIL: attempts deleted';
  exception when insufficient_privilege then null;
  end;
  -- A display name and a review decision can change.
  update public.climate_zones set display_name = 'East bay' where source_label = 'Zone 1';
  update public.climate_import_files set hour_state = 'superseded', review_note = 'kept the first' where id = (select v::uuid from t where k = 'file2');
end $$;

-- ---------------------------------------------------------------------------
-- Privacy: organization B sees nothing of A
-- ---------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"bbbbbbbb-0000-4000-8000-0000000c1001","role":"authenticated"}', true);
do $$
begin
  if exists (select 1 from public.climate_sources) or exists (select 1 from public.climate_zones)
     or exists (select 1 from public.climate_import_files) or exists (select 1 from public.climate_readings)
     or exists (select 1 from public.climate_import_attempts) or exists (select 1 from public.climate_agent_keys) then
    raise exception 'FAIL: B sees A''s climate data';
  end if;
end $$;
-- A's member reads A's data.
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-4000-8000-0000000c1002","role":"authenticated"}', true);
do $$
begin
  if (select count(*) from public.climate_readings_active) <> 3 then raise exception 'FAIL: member can''t read readings'; end if;
  if exists (select 1 from public.climate_agent_keys) then raise exception 'FAIL: a member sees agent keys'; end if;
end $$;
reset role;

-- ---------------------------------------------------------------------------
-- Planting ↔ zones: effective dates, area shares, history, isolation
-- ---------------------------------------------------------------------------
-- Readings for Zone 3 too, which Silverstone never occupies.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-4000-8000-0000000c1001","role":"authenticated"}', true);
do $$
declare
  crop uuid := 'aaaaaaaa-0000-4000-8000-0000000c1c01';
  z1 uuid := (select id from public.climate_zones where source_label = 'Zone 1');
  z2 uuid := (select id from public.climate_zones where source_label = 'Zone 2');
  c1 uuid;
  n integer;
begin
  -- Zones 1 + 2 from Jan 1 (60/40), then only Zone 2 from Oct 17.
  c1 := public.set_crop_climate_zones(crop, '2026-01-01',
          jsonb_build_array(jsonb_build_object('zone_id', z1, 'area_share', 0.6), jsonb_build_object('zone_id', z2, 'area_share', 0.4)), 'initial');
  insert into t values ('t_after_first', clock_timestamp()::text);
  perform public.set_crop_climate_zones(crop, '2026-10-17', jsonb_build_array(jsonb_build_object('zone_id', z2)), 'moved');

  if (select string_agg(source_label || '=' || coalesce(area_share::text, '-'), ',') from public.crop_climate_zones_at(crop, '2026-05-01')) <> 'Zone 1=0.6000,Zone 2=0.4000' then
    raise exception 'FAIL: May zones %', (select string_agg(source_label, ',') from public.crop_climate_zones_at(crop, '2026-05-01'));
  end if;
  if (select string_agg(source_label, ',') from public.crop_climate_zones_at(crop, '2026-10-17')) <> 'Zone 2' then raise exception 'FAIL: October zones'; end if;
  if exists (select 1 from public.crop_climate_zones_at(crop, '2025-11-01')) then raise exception 'FAIL: zones before planting'; end if;
  -- As recorded before the second change, October still had Zones 1 + 2.
  select count(*) into n from public.crop_climate_zones_at(crop, '2026-10-17', ((select v from t where k = 't_after_first')::timestamptz));
  if n <> 2 then raise exception 'FAIL: as-of history gave % zones', n; end if;

  -- Isolation: readings on Oct 17 come only from Zone 2 (not Zone 1 or Zone 3).
  if (select string_agg(distinct source_label, ',') from public.crop_climate_readings(crop, '2026-10-17 00:00+00', '2026-10-18 00:00+00')) <> 'Zone 2' then
    raise exception 'FAIL: isolation %', (select string_agg(distinct source_label, ',') from public.crop_climate_readings(crop, '2026-10-17 00:00+00', '2026-10-18 00:00+00'));
  end if;
  -- As recorded earlier, the same day read Zones 1 + 2, still never Zone 3.
  if (select string_agg(distinct source_label, ',' order by source_label) from public.crop_climate_readings(crop, '2026-10-17 00:00+00', '2026-10-18 00:00+00', ((select v from t where k = 't_after_first')::timestamptz))) <> 'Zone 1,Zone 2' then
    raise exception 'FAIL: as-of isolation';
  end if;

  -- Validation.
  begin
    perform public.set_crop_climate_zones(crop, '2026-11-01', jsonb_build_array(jsonb_build_object('zone_id', z1, 'area_share', 0.5), jsonb_build_object('zone_id', z2)));
    raise exception 'FAIL: partial shares accepted';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.set_crop_climate_zones(crop, '2026-11-01', jsonb_build_array(jsonb_build_object('zone_id', z1, 'area_share', 0.5), jsonb_build_object('zone_id', z2, 'area_share', 0.4)));
    raise exception 'FAIL: shares not summing to 100%% accepted';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.set_crop_climate_zones(crop, '2027-01-01', '[]'::jsonb);
    raise exception 'FAIL: a date after pull-out accepted';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.set_crop_climate_zones(crop, '2026-11-01', jsonb_build_array(jsonb_build_object('zone_id', z1), jsonb_build_object('zone_id', z1)));
    raise exception 'FAIL: a zone listed twice accepted';
  exception when invalid_parameter_value then null;
  end;
  -- No zones from Nov 1 is allowed.
  perform public.set_crop_climate_zones(crop, '2026-11-01', '[]'::jsonb, 'cleared');
  if exists (select 1 from public.crop_climate_zones_at(crop, '2026-11-15')) then raise exception 'FAIL: zones after clearing'; end if;
  if (select string_agg(source_label, ',') from public.crop_climate_zones_at(crop, '2026-10-20')) <> 'Zone 2' then raise exception 'FAIL: clearing changed October'; end if;

  -- Assignments are never edited or deleted.
  begin
    delete from public.crop_climate_zones;
    raise exception 'FAIL: an assignment was deleted';
  exception when insufficient_privilege then null;
  end;
end $$;

-- A member can read assignments but not change them.
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-4000-8000-0000000c1002","role":"authenticated"}', true);
do $$
begin
  if not exists (select 1 from public.crop_climate_zones) then raise exception 'FAIL: member can''t read assignments'; end if;
  perform public.set_crop_climate_zones('aaaaaaaa-0000-4000-8000-0000000c1c01', '2026-11-01', '[]'::jsonb);
  raise exception 'FAIL: a member changed zones';
exception when insufficient_privilege then null;
end $$;
reset role;

-- Superseding is the only change allowed, once.
do $$
begin
  update public.crop_climate_zones set area_share = 1 where superseded_at is null;
  raise exception 'FAIL: an assignment was edited';
exception when insufficient_privilege then null;
end $$;

select 'climate_ingest tests passed' as result;
rollback;
