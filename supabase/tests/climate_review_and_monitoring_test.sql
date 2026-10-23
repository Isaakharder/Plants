-- 20261028000000_climate_review_and_monitoring: review decisions (audited,
-- originals untouched), quarantine resolution, monitoring reads, and a
-- planting's climate limited to its own zones.
--
-- Runs inside a transaction that is always rolled back.
--   npx supabase db query --linked -f supabase/tests/climate_review_and_monitoring_test.sql
-- Prints {"result": "climate_review_and_monitoring tests passed"} on success.

begin;

insert into auth.users (id, email, aud, role) values
  ('aaaaaaaa-0000-4000-8000-0000000c2001', 'clim2-a@example.invalid', 'authenticated', 'authenticated'),
  ('aaaaaaaa-0000-4000-8000-0000000c2002', 'clim2-member@example.invalid', 'authenticated', 'authenticated'),
  ('bbbbbbbb-0000-4000-8000-0000000c2001', 'clim2-b@example.invalid', 'authenticated', 'authenticated');
insert into public.organizations (id, name) values
  ('aaaaaaaa-0000-4000-8000-0000000c20a0', 'Climate2 Org A'),
  ('bbbbbbbb-0000-4000-8000-0000000c20b0', 'Climate2 Org B');
insert into public.organization_members (organization_id, user_id, role) values
  ('aaaaaaaa-0000-4000-8000-0000000c20a0', 'aaaaaaaa-0000-4000-8000-0000000c2001', 'owner'),
  ('aaaaaaaa-0000-4000-8000-0000000c20a0', 'aaaaaaaa-0000-4000-8000-0000000c2002', 'member'),
  ('bbbbbbbb-0000-4000-8000-0000000c20b0', 'bbbbbbbb-0000-4000-8000-0000000c2001', 'owner');
insert into public.crops (id, organization_id, name, color, planting_date, pullout_date, area_m2, picking_stems, pepper_type_id) values
  ('aaaaaaaa-0000-4000-8000-0000000c2c01', 'aaaaaaaa-0000-4000-8000-0000000c20a0', 'Cadalora', 'orange', '2025-12-01', '2026-12-01', 1000, 700, (select t.id from public.pepper_types t where t.organization_id = 'aaaaaaaa-0000-4000-8000-0000000c20a0' and t.key = 'bell'));
insert into public.climate_sources (id, organization_id, name) values
  ('aaaaaaaa-0000-4000-8000-0000000c2501', 'aaaaaaaa-0000-4000-8000-0000000c20a0', 'Synopta');
insert into public.climate_agent_keys (id, organization_id, source_id, label, key_prefix, key_hash) values
  ('aaaaaaaa-0000-4000-8000-0000000c2601', 'aaaaaaaa-0000-4000-8000-0000000c20a0', 'aaaaaaaa-0000-4000-8000-0000000c2501', 'test', 'c2c2c2c2c2', repeat('c', 64));

-- Parsed-file JSON for a given UTC hour: Zones 1–3 temperature (+ pH 0.0 in Zone 1).
create function pg_temp.parsed(p_hour timestamptz, p_t1 numeric, p_t2 numeric, p_t3 numeric) returns jsonb language sql as $$
  select jsonb_build_object(
    'parserVersion', 'synopta-block-summary/1', 'status', 'parsed', 'problems', '[]'::jsonb, 'warnings', '[]'::jsonb,
    'zones', '[{"label":"Zone 1","column":1},{"label":"Zone 2","column":2},{"label":"Zone 3","column":3}]'::jsonb,
    'readings', jsonb_build_array(
      jsonb_build_object('zone','Zone 1','row_label','Air temperature [°C]','metric','air_temperature','unit','°C','unit_raw','°C','raw_text',p_t1::text,'value',p_t1,'flags','[]'::jsonb),
      jsonb_build_object('zone','Zone 2','row_label','Air temperature [°C]','metric','air_temperature','unit','°C','unit_raw','°C','raw_text',p_t2::text,'value',p_t2,'flags','[]'::jsonb),
      jsonb_build_object('zone','Zone 3','row_label','Air temperature [°C]','metric','air_temperature','unit','°C','unit_raw','°C','raw_text',p_t3::text,'value',p_t3,'flags','[]'::jsonb),
      jsonb_build_object('zone','Zone 1','row_label','Average pH','metric','ph','unit','pH','unit_raw',null,'raw_text','0.0','value',0,'flags',jsonb_build_array('ph_zero_sentinel'))),
    'meta', '{}'::jsonb,
    'time', jsonb_build_object('method','filename','hourUtc', to_char(p_hour at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
                               'hourLocal', to_char(p_hour at time zone 'America/Toronto', 'YYYY-MM-DD HH24:MI:SS')));
$$;
create function pg_temp.ingest(p_name text, p_parsed jsonb) returns jsonb language sql as $$
  select public.climate_ingest_file('aaaaaaaa-0000-4000-8000-0000000c2501', 'agent', 'aaaaaaaa-0000-4000-8000-0000000c2601', null, p_name,
    encode(convert_to(p_name || p_parsed::text, 'UTF8'), 'base64'), encode(sha256(convert_to(p_name || p_parsed::text, 'UTF8')), 'hex'), 'test', p_parsed);
$$;

create temporary table t (k text primary key, v text) on commit drop;
grant all on t to authenticated, service_role;

-- 17 Oct 2026, 08:00–12:00 Toronto (12:00–16:00 UTC), with 11:00 missing; plus a conflicting 09:00 file and a quarantined file.
set local role service_role;
do $$
declare r jsonb;
begin
  perform pg_temp.ingest('08', pg_temp.parsed('2026-10-17 12:00+00', 20, 21, 30));
  r := pg_temp.ingest('09', pg_temp.parsed('2026-10-17 13:00+00', 22, 23, 31));
  insert into t values ('first09', r->>'import_id');
  perform pg_temp.ingest('10', pg_temp.parsed('2026-10-17 14:00+00', 24, 25, 32));
  perform pg_temp.ingest('12', pg_temp.parsed('2026-10-17 16:00+00', 26, 27, 33));
  r := pg_temp.ingest('09 again', pg_temp.parsed('2026-10-17 13:00+00', 99, 99, 99));
  if r->>'status' <> 'conflict' then raise exception 'FAIL: expected a conflict, got %', r; end if;
  insert into t values ('conflict09', r->>'import_id');
  r := public.climate_ingest_file('aaaaaaaa-0000-4000-8000-0000000c2501', 'agent', 'aaaaaaaa-0000-4000-8000-0000000c2601', null, '110003.csv',
         encode(convert_to('quarantined', 'UTF8'), 'base64'), encode(sha256(convert_to('quarantined', 'UTF8')), 'hex'), 'test',
         jsonb_build_object('parserVersion', 'synopta-block-summary/1', 'status', 'quarantined', 'problems', '[{"code":"ambiguous_system_date"}]'::jsonb,
                            'zones', '[]'::jsonb, 'readings', '[]'::jsonb, 'meta', '{}'::jsonb, 'time', '{}'::jsonb));
  insert into t values ('quarantined', r->>'import_id');
end $$;
reset role;

-- ---------------------------------------------------------------------------
-- Monitoring reads (as a member)
-- ---------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-4000-8000-0000000c2002","role":"authenticated"}', true);
do $$
declare
  src uuid := 'aaaaaaaa-0000-4000-8000-0000000c2501';
  z1 uuid := (select id from public.climate_zones where source_label = 'Zone 1');
  z2 uuid := (select id from public.climate_zones where source_label = 'Zone 2');
  s jsonb;
  d jsonb;
  m jsonb;
  st jsonb;
begin
  -- Hourly series: only the zones and metrics asked for; the active 09:00 file (22, not 99).
  -- pH is not one of the six measurements (20261031): its stored readings are never returned.
  s := public.climate_series(src, array[z1], array['air_temperature', 'ph'], '2026-10-17 12:00+00', '2026-10-17 17:00+00');
  if jsonb_array_length(s) <> 1 then raise exception 'FAIL: series %', s; end if;
  if (select string_agg((p->>1), ',') from jsonb_array_elements(s) e, jsonb_array_elements(e->'points') p where e->>'metric' = 'air_temperature') <> '20,22,24,26' then
    raise exception 'FAIL: temperature points %', s;
  end if;
  if public.climate_series(src, array[z1], array['air_temperature'], '2026-01-01', '2026-10-17') <> '[]'::jsonb then raise exception 'FAIL: more than 93 days allowed'; end if;

  -- Daily: mean/min/max of usable values on the Toronto date; pH is not summarised at all.
  d := public.climate_daily(src, array[z1, z2], array['air_temperature', 'ph'], '2026-10-17', '2026-10-17');
  if (select e->'days'->0 from jsonb_array_elements(d) e where e->>'zone_id' = z1::text and e->>'metric' = 'air_temperature') <> '["2026-10-17", 4, 23.000, 20, 26, 0]'::jsonb then
    raise exception 'FAIL: daily temperature %', d;
  end if;
  if exists (select 1 from jsonb_array_elements(d) e where e->>'metric' = 'ph') then
    raise exception 'FAIL: daily pH %', d;
  end if;

  -- Missing hours: 11:00 Toronto (15:00 UTC) only.
  m := public.climate_missing_hours(src, '2026-10-17 12:00+00', '2026-10-17 17:00+00');
  if jsonb_array_length(m) <> 1 or (m->0->>2)::int <> 1 or (m->0->>0)::timestamptz <> '2026-10-17 15:00+00' then raise exception 'FAIL: missing %', m; end if;

  st := public.climate_import_status(src);
  if (st->>'to_review')::int <> 2 or (st->'files'->>'active')::int <> 4 or (st->'files'->>'conflict')::int <> 1 or (st->'files'->>'none')::int <> 1
     or (st->>'latest_hour')::timestamptz <> '2026-10-17 16:00+00' or st->'last_success'->>'filename' <> '12' then
    raise exception 'FAIL: status %', st;
  end if;

  begin
    perform public.climate_user_is_owner('aaaaaaaa-0000-4000-8000-0000000c2002', 'aaaaaaaa-0000-4000-8000-0000000c20a0');
    raise exception 'FAIL: the app can call the server-only owner check';
  exception when insufficient_privilege then null;
  end;
  -- A member can't rename zones or review.
  begin
    perform public.climate_set_zone_display_name(z1, 'East');
    raise exception 'FAIL: a member renamed a zone';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.climate_review_file((select v::uuid from t where k = 'conflict09'), 'activate', 'no');
    raise exception 'FAIL: a member reviewed';
  exception when insufficient_privilege then null;
  end;
end $$;

-- Organization B sees nothing through the reads either.
select set_config('request.jwt.claims', '{"sub":"bbbbbbbb-0000-4000-8000-0000000c2001","role":"authenticated"}', true);
do $$
begin
  if public.climate_series('aaaaaaaa-0000-4000-8000-0000000c2501', array(select id from public.climate_zones), array['air_temperature'], '2026-10-17', '2026-10-18') <> '[]'::jsonb
     or public.climate_daily('aaaaaaaa-0000-4000-8000-0000000c2501', array(select id from public.climate_zones), array['air_temperature'], '2026-10-17', '2026-10-17') <> '[]'::jsonb
     or (public.climate_import_status('aaaaaaaa-0000-4000-8000-0000000c2501')->>'to_review')::int <> 0 then
    raise exception 'FAIL: B reads A''s climate';
  end if;
  if exists (select 1 from public.climate_file_reviews) then raise exception 'FAIL: B sees reviews'; end if;
  perform public.climate_review_file((select v::uuid from t where k = 'conflict09'), 'activate', 'no');
  raise exception 'FAIL: B reviewed A''s file';
exception when insufficient_privilege then null;
end $$;

-- ---------------------------------------------------------------------------
-- Review decisions (owner): audited; originals untouched
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-4000-8000-0000000c2001","role":"authenticated"}', true);
do $$
declare
  first09 uuid := (select v::uuid from t where k = 'first09');
  conflict09 uuid := (select v::uuid from t where k = 'conflict09');
  r jsonb;
begin
  begin
    perform public.climate_review_file(conflict09, 'activate', '  ');
    raise exception 'FAIL: review without a note';
  exception when invalid_parameter_value then null;
  end;

  -- Renaming keeps the source label; blank clears the name.
  perform public.climate_set_zone_display_name((select id from public.climate_zones where source_label = 'Zone 1'), '  East bay ');
  if (select display_name || '|' || source_label from public.climate_zones where source_label = 'Zone 1') <> 'East bay|Zone 1' then raise exception 'FAIL: rename'; end if;
  perform public.climate_set_zone_display_name((select id from public.climate_zones where source_label = 'Zone 1'), ' ');
  if (select display_name from public.climate_zones where source_label = 'Zone 1') is not null then raise exception 'FAIL: clearing the name'; end if;

  r := public.climate_review_file(conflict09, 'activate', 'Re-exported after the clock fix');
  if r->>'replaced_file_id' <> first09::text then raise exception 'FAIL: activate %', r; end if;
  if (select hour_state from public.climate_import_files where id = first09) <> 'superseded'
     or (select hour_state from public.climate_import_files where id = conflict09) <> 'active' then
    raise exception 'FAIL: states after activate';
  end if;
  if (select value from public.climate_readings_active where hour_utc = '2026-10-17 13:00+00' and metric = 'air_temperature'
       and zone_id = (select id from public.climate_zones where source_label = 'Zone 1')) <> 99 then
    raise exception 'FAIL: the activated file''s readings aren''t in effect';
  end if;
  -- And back again: the first file is restored; every step is in the audit.
  perform public.climate_review_file(first09, 'activate', 'The original was right after all');
  if (select string_agg(action || ':' || state_before || '>' || state_after, ',' order by id) from public.climate_file_reviews)
     <> 'superseded_by_review:active>superseded,activate:conflict>active,superseded_by_review:active>superseded,activate:superseded>active' then
    raise exception 'FAIL: audit %', (select string_agg(action || ':' || state_before || '>' || state_after, ',' order by id) from public.climate_file_reviews);
  end if;
  if (select reviewed_by from public.climate_file_reviews order by id desc limit 1) <> 'aaaaaaaa-0000-4000-8000-0000000c2001' then raise exception 'FAIL: reviewer not recorded'; end if;
  -- Set aside is only for conflicts.
  begin
    perform public.climate_review_file(first09, 'set_aside', 'x');
    raise exception 'FAIL: set aside an active file';
  exception when invalid_parameter_value then null;
  end;
  -- Readings are never removed by a review.
  if (select count(*) from public.climate_readings where hour_utc = '2026-10-17 13:00+00') <> 8 then raise exception 'FAIL: readings changed by review'; end if;
  -- The audit can't be edited, even by an owner.
  begin
    delete from public.climate_file_reviews;
    raise exception 'FAIL: audit deleted';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

-- ---------------------------------------------------------------------------
-- Quarantine resolution (server, for an owner)
-- ---------------------------------------------------------------------------
set local role service_role;
do $$
declare
  q uuid := (select v::uuid from t where k = 'quarantined');
  r jsonb;
begin
  if not public.climate_user_is_owner('aaaaaaaa-0000-4000-8000-0000000c2001', 'aaaaaaaa-0000-4000-8000-0000000c20a0')
     or public.climate_user_is_owner('aaaaaaaa-0000-4000-8000-0000000c2002', 'aaaaaaaa-0000-4000-8000-0000000c20a0')
     or public.climate_user_is_owner('bbbbbbbb-0000-4000-8000-0000000c2001', 'aaaaaaaa-0000-4000-8000-0000000c20a0') then
    raise exception 'FAIL: owner check';
  end if;
  begin
    perform public.climate_resolve_quarantined_file(q, 'aaaaaaaa-0000-4000-8000-0000000c2002', pg_temp.parsed('2026-10-17 15:00+00', 1, 2, 3), 'member tries');
    raise exception 'FAIL: a member resolved a file';
  exception when insufficient_privilege then null;
  end;
  r := public.climate_resolve_quarantined_file(q, 'aaaaaaaa-0000-4000-8000-0000000c2001', pg_temp.parsed('2026-10-17 15:00+00', 25, 26, 32), 'Filename had no time; System date is month-first');
  if r->>'state' <> 'active' or (r->>'readings')::int <> 4 or r->>'hour_utc' <> '2026-10-17T15:00:00Z' then raise exception 'FAIL: resolve %', r; end if;
  begin
    perform public.climate_resolve_quarantined_file(q, 'aaaaaaaa-0000-4000-8000-0000000c2001', pg_temp.parsed('2026-10-17 15:00+00', 25, 26, 32), 'again');
    raise exception 'FAIL: resolved twice';
  exception when invalid_parameter_value then null;
  end;
end $$;
reset role;
do $$
declare f public.climate_import_files;
begin
  select * into f from public.climate_import_files where id = (select v::uuid from t where k = 'quarantined');
  if f.time_method <> 'review' or f.parse_status <> 'parsed' or convert_from(f.raw_bytes, 'UTF8') <> 'quarantined'
     or f.problems->0->>'code' <> 'ambiguous_system_date' then
    raise exception 'FAIL: resolved file %', f;
  end if;
  if (select action || ':' || state_after from public.climate_file_reviews where file_id = f.id) <> 'resolve_quarantine:active' then raise exception 'FAIL: resolve not audited'; end if;
  -- The gap at 11:00 is filled now.
  if public.climate_missing_hours('aaaaaaaa-0000-4000-8000-0000000c2501', '2026-10-17 12:00+00', '2026-10-17 17:00+00') <> '[]'::jsonb then raise exception 'FAIL: gap still there'; end if;
end $$;

-- ---------------------------------------------------------------------------
-- A planting's climate: its zones only, history reproducible
-- ---------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-4000-8000-0000000c2001","role":"authenticated"}', true);
do $$
declare
  crop uuid := 'aaaaaaaa-0000-4000-8000-0000000c2c01';
  z1 uuid := (select id from public.climate_zones where source_label = 'Zone 1');
  z2 uuid := (select id from public.climate_zones where source_label = 'Zone 2');
  before_move timestamptz;
  s jsonb;
begin
  perform public.set_crop_climate_zones(crop, '2026-01-01', jsonb_build_array(jsonb_build_object('zone_id', z1, 'area_share', 0.75), jsonb_build_object('zone_id', z2, 'area_share', 0.25)));
  before_move := clock_timestamp();
  perform public.set_crop_climate_zones(crop, '2026-10-17', jsonb_build_array(jsonb_build_object('zone_id', z2)));

  s := public.crop_climate_series(crop, array['air_temperature'], '2026-10-17 12:00+00', '2026-10-17 17:00+00');
  if (select string_agg(e->>'source_label', ',') from jsonb_array_elements(s) e) <> 'Zone 2' then raise exception 'FAIL: planting reads %', s; end if;
  if (s->0->'points'->0->>3) is not null then raise exception 'FAIL: share after the move should be unknown'; end if;

  s := public.crop_climate_series(crop, array['air_temperature'], '2026-10-17 12:00+00', '2026-10-17 17:00+00', before_move);
  if (select string_agg(e->>'source_label', ',' order by e->>'source_label') from jsonb_array_elements(s) e) <> 'Zone 1,Zone 2' then raise exception 'FAIL: as-of planting reads %', s; end if;
  if (select e->'points'->0->>3 from jsonb_array_elements(s) e where e->>'source_label' = 'Zone 1') <> '0.7500' then raise exception 'FAIL: as-of share %', s; end if;
  -- Zone 3 never appears for this planting.
  if s::text like '%Zone 3%' then raise exception 'FAIL: Zone 3 leaked'; end if;
end $$;
reset role;

select 'climate_review_and_monitoring tests passed' as result;
rollback;
