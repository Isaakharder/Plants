-- 20261031000000_climate_six_measurements: only the six measurements are
-- used; daily values of running totals come from the final hour's file
-- (radiation 23:00, drain 22:00, irrigation 23:00), never from sums or means;
-- restarts after midnight are handled; only files in effect count; older
-- files' readings stay stored; duplicates are still recognised.
--
-- Runs inside a transaction that is always rolled back.
-- Prints {"result": "climate_six_measurements tests passed"} on success.

begin;

insert into auth.users (id, email, aud, role) values
  ('aaaaaaaa-0000-4000-8000-0000000c4001', 'clim4-a@example.invalid', 'authenticated', 'authenticated');
insert into public.organizations (id, name) values ('aaaaaaaa-0000-4000-8000-0000000c40a0', 'Climate4 Org A');
insert into public.organization_members (organization_id, user_id, role) values
  ('aaaaaaaa-0000-4000-8000-0000000c40a0', 'aaaaaaaa-0000-4000-8000-0000000c4001', 'owner');
insert into public.climate_sources (id, organization_id, name) values
  ('aaaaaaaa-0000-4000-8000-0000000c4501', 'aaaaaaaa-0000-4000-8000-0000000c40a0', 'Synopta');

-- One hourly export at a Toronto wall-clock time, shaped like a parser /2
-- result (it still carries EC, pH, and Zone 15's radiation and drain).
create function pg_temp.parsed(p_local timestamp, rad text, drain1 text, drain15 text, irr1 text, irr2 text, temp1 text) returns jsonb language sql as $$
  select jsonb_build_object(
    'parserVersion', 'synopta-block-summary/2', 'status', 'parsed', 'problems', '[]'::jsonb, 'warnings', '[]'::jsonb,
    'zones', '[{"label":"Zone 1","column":1},{"label":"Zone 2","column":2},{"label":"Zone 15","column":15}]'::jsonb,
    'readings', jsonb_build_array(
      jsonb_build_object('zone','Zone 1','row_label','Air temperature [°C]','metric','air_temperature','unit','°C','raw_text',temp1,'value',temp1::numeric,'flags','[]'::jsonb),
      jsonb_build_object('zone','Zone 2','row_label','Air temperature [°C]','metric','air_temperature','unit','°C','raw_text','20.0','value',20,'flags','[]'::jsonb),
      jsonb_build_object('zone','Zone 1','row_label','Radiation sum [J/cm²]','metric','radiation_sum','unit','J/cm²','raw_text',rad,'value',rad::numeric,'flags','[]'::jsonb),
      jsonb_build_object('zone','Zone 15','row_label','Radiation sum [J/cm²]','metric','radiation_sum','unit','J/cm²','raw_text',rad,'value',rad::numeric,'flags','[]'::jsonb),
      jsonb_build_object('zone','Zone 1','row_label','Cumulative drain water percentage [%]','metric','drain_percentage','unit','%','raw_text',drain1,'value',drain1::numeric,'flags','[]'::jsonb),
      jsonb_build_object('zone','Zone 15','row_label','Cumulative drain water percentage [%]','metric','drain_percentage','unit','%','raw_text',drain15,'value',drain15::numeric,'flags','[]'::jsonb),
      jsonb_build_object('zone','Zone 1','row_label','Cumulative irrigation (dripper) [ml/dripp]','metric','irrigation_cumulative','unit','ml/dripper','raw_text',irr1,'value',irr1::numeric,'flags','[]'::jsonb),
      jsonb_build_object('zone','Zone 2','row_label','Cumulative irrigation (dripper) [ml/dripp]','metric','irrigation_cumulative','unit','ml/dripper','raw_text',irr2,'value',irr2::numeric,'flags','[]'::jsonb),
      jsonb_build_object('zone','Zone 1','row_label','Average EC [mS/cm]','metric','ec','unit','mS/cm','raw_text','1.8','value',1.8,'flags','[]'::jsonb),
      jsonb_build_object('zone','Zone 1','row_label','Average pH','metric','ph','unit','pH','raw_text','4.3','value',4.3,'flags','[]'::jsonb)),
    'meta', '{}'::jsonb,
    'time', jsonb_build_object('method','filename',
      'hourUtc', to_char((p_local at time zone 'America/Toronto') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
      'hourLocal', to_char(p_local, 'YYYY-MM-DD HH24:MI:SS')));
$$;
create function pg_temp.ingest(p_tag text, p_parsed jsonb) returns jsonb language sql as $$
  select public.climate_ingest_file('aaaaaaaa-0000-4000-8000-0000000c4501', 'manual', null, 'aaaaaaaa-0000-4000-8000-0000000c4001', p_tag || '.csv',
    encode(convert_to(p_tag || p_parsed::text, 'UTF8'), 'base64'), encode(sha256(convert_to(p_tag || p_parsed::text, 'UTF8')), 'hex'), null, p_parsed);
$$;

create temporary table t (k text primary key, v text) on commit drop;
grant all on t to authenticated, service_role;

-- 10 Oct 23:00 (yesterday's totals), all of 11 Oct, and 12 Oct 00:00–10:00 (no 22:00/23:00).
--   radiation: 500 held 00–07, restarts 08:00, rises to 342.9 by 18:00, held to 23:00 (and overnight)
--   drain Zone 1: yesterday's 35.8 still at 00:00, restarts 01:00, 48.0 at 22:00, 48.1 at 23:00
--   drain Zone 15: a different figure (ignored)
--   irrigation: 0 from 00:00, rising from 09:00; Zone 1 ends at 871, Zone 2 at 900
set local role service_role;
do $$
declare
  h integer;
  rad text; d1 text; irr1 text; irr2 text;
begin
  perform pg_temp.ingest('2026-10-10_23', pg_temp.parsed('2026-10-10 23:00', '500.0', '35.8', '11.4', '504', '520', '18.0'));
  for h in 0..23 loop
    rad := case when h < 8 then '500.0' when h >= 18 then '342.9' else ((h - 7) * 30)::text || '.0' end;
    d1 := case when h = 0 then '35.8' when h = 22 then '48.0' when h = 23 then '48.1' else (h * 2)::text || '.0' end;
    irr1 := case when h < 9 then '0' when h >= 17 then '871' else ((h - 8) * 100)::text end;
    irr2 := case when h < 9 then '0' when h >= 17 then '900' else ((h - 8) * 110)::text end;
    perform pg_temp.ingest('2026-10-11_' || h, pg_temp.parsed(('2026-10-11'::timestamp + make_interval(hours => h)), rad, d1, '17.9', irr1, irr2, (18 + h / 4.0)::numeric(4,1)::text));
  end loop;
  for h in 0..10 loop
    rad := case when h < 8 then '342.9' else ((h - 7) * 5)::text || '.0' end;
    d1 := case when h = 0 then '48.1' else (h * 3)::text || '.0' end;
    perform pg_temp.ingest('2026-10-12_' || h, pg_temp.parsed(('2026-10-12'::timestamp + make_interval(hours => h)), rad, d1, '1.0', case when h < 9 then '0' else '50' end, '0', '19.0'));
  end loop;
end $$;
reset role;

-- ---------------------------------------------------------------------------
-- Only the six measurements are in effect; the other stored readings remain.
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from public.climate_readings_active where metric in ('ec', 'ph')) then raise exception 'FAIL: EC/pH in effect'; end if;
  if exists (select 1 from public.climate_readings_active a join public.climate_zones z on z.id = a.zone_id
              where a.metric in ('radiation_sum', 'drain_percentage') and z.source_label <> 'Zone 1') then
    raise exception 'FAIL: Zone 15 radiation/drain in effect';
  end if;
  -- 36 files × (2 temperature + 1 radiation + 1 drain + 2 irrigation) in effect; all 10 readings per file still stored.
  if (select count(*) from public.climate_readings_active) <> 36 * 6 or (select count(*) from public.climate_readings) <> 36 * 10 then
    raise exception 'FAIL: % in effect, % stored', (select count(*) from public.climate_readings_active), (select count(*) from public.climate_readings);
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Daily values
-- ---------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-4000-8000-0000000c4001","role":"authenticated"}', true);
do $$
declare
  src uuid := 'aaaaaaaa-0000-4000-8000-0000000c4501';
  z1 uuid := (select id from public.climate_zones where source_label = 'Zone 1');
  z2 uuid := (select id from public.climate_zones where source_label = 'Zone 2');
  r record;
begin
  -- 11 Oct radiation: the 23:00 reading, restart at 08:00 seen; never a sum of the 24 snapshots.
  select * into r from public.climate_daily_totals(src, '2026-10-11', '2026-10-13') where local_date = '2026-10-11' and metric = 'radiation_sum';
  if r.zone_id <> z1 or r.final_hour <> 23 or r.final_value <> 342.9 or r.status <> 'final' or r.restart_hour <> 8 or r.problems <> '{}' then
    raise exception 'FAIL: radiation 11 Oct %', r;
  end if;
  -- 11 Oct drain: the 22:00 reading (48.0), not 23:00 (48.1), not a mean; 00:00 still held 10 Oct's figure, restart at 01:00.
  select * into r from public.climate_daily_totals(src, '2026-10-11', '2026-10-13') where local_date = '2026-10-11' and metric = 'drain_percentage';
  if r.final_value <> 48.0 or r.final_hour <> 22 or r.status <> 'final' or r.restart_hour <> 1 then raise exception 'FAIL: drain 11 Oct %', r; end if;
  -- 11 Oct irrigation per zone: each zone's 23:00 reading.
  if (select string_agg(final_value::text || ':' || status, ',' order by zone_id = z1 desc)
        from public.climate_daily_totals(src, '2026-10-11', '2026-10-11') where metric = 'irrigation_cumulative') <> '871:final,900:final' then
    raise exception 'FAIL: irrigation 11 Oct %', (select array_agg(final_value) from public.climate_daily_totals(src, '2026-10-11', '2026-10-11') where metric = 'irrigation_cumulative');
  end if;

  -- 12 Oct (past, no 22:00/23:00 file): incomplete, with the running value after that day's restart.
  select * into r from public.climate_daily_totals(src, '2026-10-11', '2026-10-13') where local_date = '2026-10-12' and metric = 'radiation_sum';
  -- 00:00–07:00 still show 11 Oct's 342.9; the counter restarts at 08:00 and is 15.0 at 10:00.
  if r.final_value is not null or r.status <> 'incomplete' or r.running_value <> 15.0 or r.running_hour <> 10 or r.restart_hour <> 8 then
    raise exception 'FAIL: radiation 12 Oct %', r;
  end if;
  select * into r from public.climate_daily_totals(src, '2026-10-11', '2026-10-13') where local_date = '2026-10-12' and metric = 'drain_percentage';
  if r.status <> 'incomplete' or r.running_value <> 30.0 or r.restart_hour <> 1 then raise exception 'FAIL: drain 12 Oct %', r; end if;
  -- 13 Oct: no file at all.
  if (select status from public.climate_daily_totals(src, '2026-10-11', '2026-10-13') where local_date = '2026-10-13' and metric = 'radiation_sum') <> 'no_data' then
    raise exception 'FAIL: 13 Oct';
  end if;
  -- A future date is "running" (pending), not incomplete.
  if (select status from public.climate_daily_totals(src, current_date + 2, current_date + 2) where metric = 'radiation_sum') <> 'running' then
    raise exception 'FAIL: future date';
  end if;

  -- Greenhouse-wide values are the same whatever zones are asked for (shared by every zone and planting).
  if (select array_agg(final_value order by local_date, metric) from public.climate_daily_totals(src, '2026-10-11', '2026-10-12', array[z2]) where metric <> 'irrigation_cumulative')
     is distinct from (select array_agg(final_value order by local_date, metric) from public.climate_daily_totals(src, '2026-10-11', '2026-10-12') where metric <> 'irrigation_cumulative') then
    raise exception 'FAIL: greenhouse values depend on the zones asked for';
  end if;
  if exists (select 1 from public.climate_daily_totals(src, '2026-10-11', '2026-10-11', array[z2]) where metric = 'irrigation_cumulative' and zone_id <> z2) then
    raise exception 'FAIL: irrigation zones not limited';
  end if;

  -- climate_daily: means of the hourly measurements only; running totals, EC and pH get nothing.
  if public.climate_daily(src, array[z1, z2], array['radiation_sum', 'drain_percentage', 'irrigation_cumulative', 'ec', 'ph'], '2026-10-11', '2026-10-11') <> '[]'::jsonb then
    raise exception 'FAIL: climate_daily summarised a running total or EC/pH';
  end if;
  if (select e->'days'->0->>1 from jsonb_array_elements(public.climate_daily(src, array[z2], array['air_temperature'], '2026-10-11', '2026-10-11')) e) <> '24' then
    raise exception 'FAIL: daily temperature';
  end if;
end $$;
reset role;

-- ---------------------------------------------------------------------------
-- Only the file in effect counts; a different 23:00 file is a conflict until an owner decides.
-- ---------------------------------------------------------------------------
set local role service_role;
do $$
declare r jsonb;
begin
  r := pg_temp.ingest('2026-10-11_23 re-export', pg_temp.parsed('2026-10-11 23:00', '999.9', '48.1', '17.9', '871', '900', '23.7'));
  if r->>'status' <> 'conflict' then raise exception 'FAIL: expected a conflict %', r; end if;
  insert into t values ('conflict', r->>'import_id');
  -- Older files stay duplicates: the same readings again (new bytes, and without the EC/pH rows parser /3 drops) for 11 Oct 10:00.
  r := pg_temp.ingest('2026-10-11_10 re-saved', pg_temp.parsed('2026-10-11 10:00', '90.0', '20.0', '0.0', '200', '220', '20.5') #- '{readings,9}' #- '{readings,8}');
  if r->>'status' <> 'duplicate' or r->>'reason' <> 'same_readings' then raise exception 'FAIL: older file not recognised %', r; end if;
end $$;
reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-4000-8000-0000000c4001","role":"authenticated"}', true);
do $$
begin
  if (select final_value from public.climate_daily_totals('aaaaaaaa-0000-4000-8000-0000000c4501', '2026-10-11', '2026-10-11') where metric = 'radiation_sum') <> 342.9 then
    raise exception 'FAIL: a conflict changed the daily radiation';
  end if;
  perform public.climate_review_file((select v::uuid from t where k = 'conflict'), 'activate', 'Corrected export');
  if (select final_value from public.climate_daily_totals('aaaaaaaa-0000-4000-8000-0000000c4501', '2026-10-11', '2026-10-11') where metric = 'radiation_sum') <> 999.9 then
    raise exception 'FAIL: the activated file is not used';
  end if;
end $$;
reset role;

select '{"result": "climate_six_measurements tests passed"}';
rollback;
