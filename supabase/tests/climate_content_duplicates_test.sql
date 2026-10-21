-- 20261030000000_climate_content_duplicates: duplicates recognised by their
-- readings (re-saved copies), readings repeated at another hour held for
-- review, the existing protections unchanged, and every climate calculation
-- using only the hour's file in effect (never a duplicate or a conflict).
--
-- Runs inside a transaction that is always rolled back.
-- Prints {"result": "climate_content_duplicates tests passed"} on success.

begin;

insert into auth.users (id, email, aud, role) values
  ('aaaaaaaa-0000-4000-8000-0000000c3001', 'clim3-a@example.invalid', 'authenticated', 'authenticated');
insert into public.organizations (id, name) values ('aaaaaaaa-0000-4000-8000-0000000c30a0', 'Climate3 Org A');
insert into public.organization_members (organization_id, user_id, role) values
  ('aaaaaaaa-0000-4000-8000-0000000c30a0', 'aaaaaaaa-0000-4000-8000-0000000c3001', 'owner');
insert into public.crops (id, organization_id, name, color, planting_date, pullout_date, area_m2, picking_stems) values
  ('aaaaaaaa-0000-4000-8000-0000000c3c01', 'aaaaaaaa-0000-4000-8000-0000000c30a0', 'Crop', 'red', '2025-12-01', '2026-12-01', 1000, 700);
insert into public.climate_sources (id, organization_id, name) values
  ('aaaaaaaa-0000-4000-8000-0000000c3501', 'aaaaaaaa-0000-4000-8000-0000000c30a0', 'Synopta');

-- Parsed-file JSON for a UTC hour: Zones 1–2 temperature.
create function pg_temp.parsed(p_hour timestamptz, p_t1 text, p_t2 text) returns jsonb language sql as $$
  select jsonb_build_object(
    'parserVersion', 'synopta-block-summary/2', 'status', 'parsed', 'problems', '[]'::jsonb, 'warnings', '[]'::jsonb,
    'zones', '[{"label":"Zone 1","column":1},{"label":"Zone 2","column":2}]'::jsonb,
    'readings', jsonb_build_array(
      jsonb_build_object('zone','Zone 1','row_label','Air temperature [°C]','metric','air_temperature','unit','°C','unit_raw','°C','raw_text',p_t1,'value',p_t1::numeric,'flags','[]'::jsonb),
      jsonb_build_object('zone','Zone 2','row_label','Air temperature [°C]','metric','air_temperature','unit','°C','unit_raw','°C','raw_text',p_t2,'value',p_t2::numeric,'flags','[]'::jsonb)),
    'meta', '{}'::jsonb,
    'time', jsonb_build_object('method','filename','hourUtc', to_char(p_hour at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
                               'hourLocal', to_char(p_hour at time zone 'America/Toronto', 'YYYY-MM-DD HH24:MI:SS')));
$$;
-- The bytes are the name + a variant tag + the readings: same name and tag → same bytes.
create function pg_temp.ingest(p_name text, p_bytes_tag text, p_parsed jsonb) returns jsonb language sql as $$
  select public.climate_ingest_file('aaaaaaaa-0000-4000-8000-0000000c3501', 'manual', null, 'aaaaaaaa-0000-4000-8000-0000000c3001', p_name,
    encode(convert_to(p_bytes_tag || p_parsed::text, 'UTF8'), 'base64'), encode(sha256(convert_to(p_bytes_tag || p_parsed::text, 'UTF8')), 'hex'), null, p_parsed);
$$;

create temporary table t (k text primary key, v text) on commit drop;
grant all on t to authenticated, service_role;

set local role service_role;
do $$
declare r jsonb;
begin
  -- 08:00 and 09:00 Toronto (12:00, 13:00 UTC).
  r := pg_temp.ingest('Block Summary_20261017_080003.csv', 'a', pg_temp.parsed('2026-10-17 12:00+00', '20.0', '21.0'));
  if r->>'status' <> 'created' then raise exception 'FAIL: 08 %', r; end if;
  insert into t values ('f08', r->>'import_id');
  r := pg_temp.ingest('Block Summary_20261017_090003.csv', 'a', pg_temp.parsed('2026-10-17 13:00+00', '22.0', '23.0'));
  insert into t values ('f09', r->>'import_id');

  -- Same bytes, another name: duplicate (unchanged), and it names the file it matches.
  r := pg_temp.ingest('copy of 08.csv', 'a', pg_temp.parsed('2026-10-17 12:00+00', '20.0', '21.0'));
  if r->>'status' <> 'duplicate' or r->>'reason' <> 'same_bytes' or r->>'import_id' <> (select v from t where k = 'f08')
     or r#>>'{matched,filename}' <> 'Block Summary_20261017_080003.csv' or r#>>'{matched,file_status}' <> 'active' or r#>>'{matched,received_at}' is null then
    raise exception 'FAIL: byte duplicate %', r;
  end if;

  -- Re-saved copy (new bytes), same hour, same readings: duplicate by readings; nothing stored.
  r := pg_temp.ingest('Block Summary_20261017_080003.csv', 'resaved', pg_temp.parsed('2026-10-17 12:00+00', '20.0', '21.0'));
  if r->>'status' <> 'duplicate' or r->>'reason' <> 'same_readings' or r->>'import_id' <> (select v from t where k = 'f08') then
    raise exception 'FAIL: re-saved copy %', r;
  end if;

  -- A real second file for 08:00 (different readings): still a conflict, naming the file in effect.
  r := pg_temp.ingest('Block Summary_20261017_080003 (2).csv', 'b', pg_temp.parsed('2026-10-17 12:00+00', '20.0', '29.0'));
  if r->>'status' <> 'conflict' or r->>'reason' <> 'different_readings_same_hour' or r#>>'{matched,file_id}' <> (select v from t where k = 'f08') then
    raise exception 'FAIL: conflict %', r;
  end if;
  insert into t values ('c08', r->>'import_id');
  -- A re-saved copy of that conflict is a duplicate of it (the file in effect is preferred only when it matches).
  r := pg_temp.ingest('again.csv', 'b2', pg_temp.parsed('2026-10-17 12:00+00', '20.0', '29.0'));
  if r->>'status' <> 'duplicate' or r->>'reason' <> 'same_readings' or r->>'import_id' <> (select v from t where k = 'c08') then
    raise exception 'FAIL: copy of a conflict %', r;
  end if;

  -- The 08:00 readings renamed to 13:00 (new bytes): held for review, not used for 13:00.
  r := pg_temp.ingest('Block Summary_20261017_130003.csv', 'renamed', pg_temp.parsed('2026-10-17 17:00+00', '20.0', '21.0'));
  if r->>'status' <> 'quarantined' or r->>'reason' <> 'same_readings_as_other_hour' or r->>'file_status' <> 'none'
     or r#>>'{matched,file_id}' <> (select v from t where k = 'f08') or r ? 'hour_utc' then
    raise exception 'FAIL: other hour %', r;
  end if;
  insert into t values ('h13', r->>'import_id');
end $$;
reset role;

do $$
declare f public.climate_import_files;
begin
  select * into f from public.climate_import_files where id = (select v::uuid from t where k = 'h13');
  if f.hour_utc is not null or f.parse_status <> 'quarantined' or f.problems->0->>'code' <> 'same_readings_as_other_hour'
     or f.problems->0->>'message' not like '%2026-10-17 08:00 file (Block Summary_20261017_080003.csv)%' or f.raw_bytes is null then
    raise exception 'FAIL: held file stored as % %', f.parse_status, f.problems;
  end if;
  if exists (select 1 from public.climate_readings where file_id = f.id) then raise exception 'FAIL: a held file has readings'; end if;
  -- Files: 08, 09, the 08 conflict, the held one. Nothing else stored.
  if (select count(*) from public.climate_import_files) <> 4 then raise exception 'FAIL: % files', (select count(*) from public.climate_import_files); end if;
  if (select string_agg(outcome || coalesce(':' || (detail->>'reason'), ''), ',' order by id) from public.climate_import_attempts)
     <> 'created,created,duplicate:same_bytes,duplicate:same_readings,conflict:different_readings_same_hour,duplicate:same_readings,quarantined:same_readings_as_other_hour' then
    raise exception 'FAIL: attempts %', (select string_agg(outcome || coalesce(':' || (detail->>'reason'), ''), ',' order by id) from public.climate_import_attempts);
  end if;
  -- Every stored file with readings has its fingerprint; the same readings give the same fingerprint.
  if (select count(*) from public.climate_file_contents) <> 3 then raise exception 'FAIL: % fingerprints', (select count(*) from public.climate_file_contents); end if;
  if public.climate_readings_fingerprint('[{"zone":"Zone 2","row_label":"x","raw_text":"1"},{"zone":"Zone 1","row_label":"x","raw_text":"1"}]')
     <> public.climate_readings_fingerprint('[{"zone":"Zone 1","row_label":"x","raw_text":"1"},{"zone":"Zone 2","row_label":"x","raw_text":"1"}]')
     or public.climate_readings_fingerprint('[{"zone":"Zone 1","row_label":"x","raw_text":"1"}]') = public.climate_readings_fingerprint('[{"zone":"Zone 1","row_label":"x","raw_text":"1.0"}]') then
    raise exception 'FAIL: fingerprint';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Existing protections: one active file per hour, history immutable.
-- ---------------------------------------------------------------------------
do $$
begin
  begin
    update public.climate_import_files set hour_state = 'active' where id = (select v::uuid from t where k = 'c08');
    raise exception 'FAIL: two active files for one hour';
  exception when unique_violation then null;
  end;
  begin
    delete from public.climate_file_contents;
    raise exception 'FAIL: fingerprints can be deleted';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.climate_file_contents set content_sha256 = repeat('0', 64);
    raise exception 'FAIL: fingerprints can be changed';
  exception when insufficient_privilege then null;
  end;
  begin
    delete from public.climate_import_files where id = (select v::uuid from t where k = 'h13');
    raise exception 'FAIL: a held file can be deleted';
  exception when insufficient_privilege then null;
  end;
end $$;

-- ---------------------------------------------------------------------------
-- Calculations use only the file in effect for each hour.
-- ---------------------------------------------------------------------------
-- The planting occupies Zones 1 and 2 (half each).
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-4000-8000-0000000c3001","role":"authenticated"}', true);
select public.set_crop_climate_zones('aaaaaaaa-0000-4000-8000-0000000c3c01', '2026-01-01',
  (select jsonb_agg(jsonb_build_object('zone_id', id, 'area_share', 0.5)) from public.climate_zones));

do $$
declare
  src uuid := 'aaaaaaaa-0000-4000-8000-0000000c3501';
  z1 uuid := (select id from public.climate_zones where source_label = 'Zone 1');
  z2 uuid := (select id from public.climate_zones where source_label = 'Zone 2');
  s jsonb;
  d jsonb;
begin
  -- Raw readings hold the conflict's too (kept for review), but no calculation sees them.
  if (select count(*) from public.climate_readings) <> 6 or (select count(*) from public.climate_readings_active) <> 4 then
    raise exception 'FAIL: readings % / active %', (select count(*) from public.climate_readings), (select count(*) from public.climate_readings_active);
  end if;
  if exists (select 1 from public.climate_readings_active group by source_id, zone_id, row_label, hour_utc having count(*) > 1) then
    raise exception 'FAIL: two readings in effect for one zone, row and hour';
  end if;
  -- Series: one point per hour, the active values (Zone 2 at 08:00 is 21, not the conflict's 29).
  s := public.climate_series(src, array[z2], array['air_temperature'], '2026-10-17 12:00+00', '2026-10-17 18:00+00');
  if jsonb_array_length(s->0->'points') <> 2 or (s->0->'points'->0->>1)::numeric <> 21 then raise exception 'FAIL: series %', s; end if;
  -- Daily mean of Zone 2: (21 + 23) / 2 = 22 over 2 hours.
  d := public.climate_daily(src, array[z2], array['air_temperature'], '2026-10-17', '2026-10-17');
  if (d->0->'days'->0->>1)::int <> 2 or (d->0->'days'->0->>2)::numeric <> 22 then raise exception 'FAIL: daily %', d; end if;
  -- The planting's readings: 2 zones × 2 hours, never the conflict or the held copy.
  if (select count(*) from public.crop_climate_readings('aaaaaaaa-0000-4000-8000-0000000c3c01', '2026-10-17 12:00+00', '2026-10-17 18:00+00')) <> 4 then
    raise exception 'FAIL: crop readings %', (select count(*) from public.crop_climate_readings('aaaaaaaa-0000-4000-8000-0000000c3c01', '2026-10-17 12:00+00', '2026-10-17 18:00+00'));
  end if;
  if exists (select 1 from public.crop_climate_readings('aaaaaaaa-0000-4000-8000-0000000c3c01', '2026-10-17 12:00+00', '2026-10-17 18:00+00') where value = 29) then
    raise exception 'FAIL: the conflict''s value reached the planting';
  end if;
  -- 13:00 Toronto (17:00 UTC) is still missing: the held copy didn't fill it.
  if jsonb_array_length(public.climate_missing_hours(src, '2026-10-17 12:00+00', '2026-10-17 18:00+00')) <> 1
     or (public.climate_missing_hours(src, '2026-10-17 12:00+00', '2026-10-17 18:00+00')->0->>0)::timestamptz <> '2026-10-17 14:00+00'
     or (public.climate_missing_hours(src, '2026-10-17 12:00+00', '2026-10-17 18:00+00')->0->>2)::int <> 4 then
    raise exception 'FAIL: missing hours %', public.climate_missing_hours(src, '2026-10-17 12:00+00', '2026-10-17 18:00+00');
  end if;

  -- An owner puts the conflict into effect: still one value per hour, now the conflict's.
  perform public.climate_review_file((select v::uuid from t where k = 'c08'), 'activate', 'Re-exported after a sensor fix');
  s := public.climate_series(src, array[z2], array['air_temperature'], '2026-10-17 12:00+00', '2026-10-17 18:00+00');
  if jsonb_array_length(s->0->'points') <> 2 or (s->0->'points'->0->>1)::numeric <> 29 then raise exception 'FAIL: series after review %', s; end if;
  if (select count(*) from public.crop_climate_readings('aaaaaaaa-0000-4000-8000-0000000c3c01', '2026-10-17 12:00+00', '2026-10-17 18:00+00')) <> 4 then
    raise exception 'FAIL: crop readings after review';
  end if;
end $$;
reset role;

-- An owner who decides the held copy really is 13:00 (e.g. frozen sensors) can still assign it.
set local role service_role;
do $$
declare r jsonb;
begin
  r := public.climate_resolve_quarantined_file((select v::uuid from t where k = 'h13'), 'aaaaaaaa-0000-4000-8000-0000000c3001',
         pg_temp.parsed('2026-10-17 17:00+00', '20.0', '21.0') || '{"parserVersion":"synopta-block-summary/2"}', 'Sensors were frozen; values really repeated');
  if r->>'state' <> 'active' or (r->>'readings')::int <> 2 then raise exception 'FAIL: resolve %', r; end if;
end $$;
reset role;
do $$
begin
  if (select count(*) from public.climate_file_contents where file_id = (select v::uuid from t where k = 'h13')) <> 1 then
    raise exception 'FAIL: resolved file has no fingerprint';
  end if;
end $$;

select '{"result": "climate_content_duplicates tests passed"}';
rollback;
