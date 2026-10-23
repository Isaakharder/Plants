-- 20261101000000_variety_climate: one combined climate reading per variety,
-- measurement and hour (crop_climate_hourly) and per local date
-- (crop_climate_daily), reproducible as of any moment.
--
-- Runs inside a transaction that is always rolled back.
-- Prints {"result": "variety_climate tests passed"} on success.

begin;

insert into auth.users (id, email, aud, role) values
  ('aaaaaaaa-0000-4000-8000-0000000c5001', 'clim5-a@example.invalid', 'authenticated', 'authenticated'),
  ('bbbbbbbb-0000-4000-8000-0000000c5001', 'clim5-b@example.invalid', 'authenticated', 'authenticated');
insert into public.organizations (id, name) values
  ('aaaaaaaa-0000-4000-8000-0000000c50a0', 'Climate5 Org A'), ('bbbbbbbb-0000-4000-8000-0000000c50b0', 'Climate5 Org B');
insert into public.organization_members (organization_id, user_id, role) values
  ('aaaaaaaa-0000-4000-8000-0000000c50a0', 'aaaaaaaa-0000-4000-8000-0000000c5001', 'owner'),
  ('bbbbbbbb-0000-4000-8000-0000000c50b0', 'bbbbbbbb-0000-4000-8000-0000000c5001', 'owner');
insert into public.crops (id, organization_id, name, color, planting_date, pullout_date, area_m2, picking_stems, pepper_type_id) values
  ('aaaaaaaa-0000-4000-8000-0000000c5c01', 'aaaaaaaa-0000-4000-8000-0000000c50a0', 'Variety A', 'red', '2026-01-05', '2026-12-15', 1000, 7000, (select t.id from public.pepper_types t where t.organization_id = 'aaaaaaaa-0000-4000-8000-0000000c50a0' and t.key = 'bell')),
  ('aaaaaaaa-0000-4000-8000-0000000c5c02', 'aaaaaaaa-0000-4000-8000-0000000c50a0', 'Variety B', 'yellow', '2026-01-05', '2026-12-15', 1000, 7000, (select t.id from public.pepper_types t where t.organization_id = 'aaaaaaaa-0000-4000-8000-0000000c50a0' and t.key = 'bell'));
insert into public.climate_sources (id, organization_id, name) values
  ('aaaaaaaa-0000-4000-8000-0000000c5501', 'aaaaaaaa-0000-4000-8000-0000000c50a0', 'Synopta');

-- One hourly export (parser /3 shape) at a Toronto wall-clock time, Zones 1–4.
--   temperature zone z: 20 + z (+ hour/10); RH 70 + z; CO₂ 400 + 10 z
--   irrigation zone z: 0 until 08:00, then (h − 8) × 10 × z, i.e. 150 z at 23:00
--   radiation (column B / Zone 1 only): given per call
create function pg_temp.parsed(p_local timestamp, rad text, p_skip text default null, p_flag text default null) returns jsonb language sql as $$
  select jsonb_build_object(
    'parserVersion', 'synopta-block-summary/3', 'status', 'parsed', 'problems', '[]'::jsonb, 'warnings', '[]'::jsonb,
    'zones', '[{"label":"Zone 1","column":1},{"label":"Zone 2","column":2},{"label":"Zone 3","column":3},{"label":"Zone 4","column":4}]'::jsonb,
    'readings', (
      select jsonb_agg(x) from (
        select jsonb_build_object('zone', 'Zone ' || z, 'row_label', lbl, 'metric', m, 'unit', null, 'raw_text', case when p_flag = m || z then '--' else v::text end,
                                  'value', case when p_flag = m || z then null else v end,
                                  'flags', case when p_flag = m || z then '["not_numeric"]'::jsonb else '[]'::jsonb end) as x
          from generate_series(1, 4) z,
          lateral (values
            ('air_temperature', 'Air temperature [°C]', round(20 + z + extract(hour from p_local) / 10.0, 1)),
            ('relative_humidity', 'RH [%]', 70 + z::numeric),
            ('co2', 'CO2 concentration [ppm]', 400 + 10 * z::numeric),
            ('irrigation_cumulative', 'Cumulative irrigation (dripper) [ml/dripp]', greatest(0, extract(hour from p_local) - 8) * 10 * z)) t(m, lbl, v)
         where p_skip is distinct from m || z
        union all
        select jsonb_build_object('zone', 'Zone 1', 'row_label', 'Radiation sum [J/cm²]', 'metric', 'radiation_sum', 'unit', 'J/cm²', 'raw_text', rad, 'value', rad::numeric, 'flags', '[]'::jsonb)
      ) q),
    'meta', '{}'::jsonb,
    'time', jsonb_build_object('method','filename',
      'hourUtc', to_char((p_local at time zone 'America/Toronto') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
      'hourLocal', to_char(p_local, 'YYYY-MM-DD HH24:MI:SS')));
$$;
create function pg_temp.ingest(p_tag text, p_parsed jsonb) returns jsonb language sql as $$
  select public.climate_ingest_file('aaaaaaaa-0000-4000-8000-0000000c5501', 'manual', null, 'aaaaaaaa-0000-4000-8000-0000000c5001', p_tag || '.csv',
    encode(convert_to(p_tag || p_parsed::text, 'UTF8'), 'base64'), encode(sha256(convert_to(p_tag || p_parsed::text, 'UTF8')), 'hex'), null, p_parsed);
$$;
create temporary table t (k text primary key, v text) on commit drop;
grant all on t to authenticated, service_role;

-- 9 Oct 23:00, all of 10 Oct, 11 Oct 00:00–12:00 (no 23:00).
--   10 Oct 12:00: Zone 3 temperature missing; 13:00: Zone 2 temperature flagged not a number; 15:00: Zone 4 irrigation missing.
--   Radiation: 500 held until 08:00, restart, 342.9 from 18:00; 11 Oct restarts at 08:00 and is 15.0 at 10:00.
set local role service_role;
do $$
declare h integer; rad text;
begin
  perform pg_temp.ingest('09_23', pg_temp.parsed('2026-10-09 23:00', '500.0'));
  for h in 0..23 loop
    rad := case when h < 8 then '500.0' when h >= 18 then '342.9' else ((h - 7) * 30)::text || '.0' end;
    perform pg_temp.ingest('10_' || h, pg_temp.parsed('2026-10-10'::timestamp + make_interval(hours => h), rad,
      case h when 12 then 'air_temperature3' when 15 then 'irrigation_cumulative4' end,
      case h when 13 then 'air_temperature2' end));
  end loop;
  for h in 0..12 loop
    rad := case when h < 8 then '342.9' else ((h - 7) * 5)::text || '.0' end;
    perform pg_temp.ingest('11_' || h, pg_temp.parsed('2026-10-11'::timestamp + make_interval(hours => h), rad));
  end loop;
end $$;
reset role;

-- Zone assignments (as the owner). Variety A: Zones 1–3 from 1 Oct. Variety B: Zone 4 only (not Zone 1).
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-4000-8000-0000000c5001","role":"authenticated"}', true);
select public.set_crop_climate_zones('aaaaaaaa-0000-4000-8000-0000000c5c01', '2026-10-01',
  (select jsonb_agg(jsonb_build_object('zone_id', id)) from public.climate_zones where source_label in ('Zone 1', 'Zone 2', 'Zone 3')));
select public.set_crop_climate_zones('aaaaaaaa-0000-4000-8000-0000000c5c02', '2026-10-01',
  (select jsonb_agg(jsonb_build_object('zone_id', id)) from public.climate_zones where source_label = 'Zone 4'));
reset role;
insert into t values ('before_change', clock_timestamp()::text);

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-4000-8000-0000000c5001","role":"authenticated"}', true);
do $$
declare
  a uuid := 'aaaaaaaa-0000-4000-8000-0000000c5c01';
  b uuid := 'aaaaaaaa-0000-4000-8000-0000000c5c02';
  r record;
begin
  -- 10 Oct 10:00 (14:00 UTC): plain mean of Zones 1–3 (no area shares).
  select * into r from public.crop_climate_hourly(a, '2026-10-10 14:00+00', '2026-10-10 15:00+00') where metric = 'air_temperature';
  if r.value <> 23.0 or r.method <> 'mean' or r.zones_assigned <> 3 or r.zones_used <> 3 or r.coverage <> 1 or jsonb_array_length(r.inputs) <> 3 then
    raise exception 'FAIL: 10:00 temperature %', r;
  end if;
  -- 12:00: Zone 3 missing → 2 of 3 zones (67 % < 75 %): no value, never 0.
  select * into r from public.crop_climate_hourly(a, '2026-10-10 16:00+00', '2026-10-10 17:00+00') where metric = 'air_temperature';
  if r.value is not null or r.zones_used <> 2 or r.coverage <> 0.6667 then raise exception 'FAIL: 12:00 missing zone %', r; end if;
  -- 13:00: Zone 2 flagged → left out, not 0 (the hour has no value either: 2 of 3).
  select * into r from public.crop_climate_hourly(a, '2026-10-10 17:00+00', '2026-10-10 18:00+00') where metric = 'air_temperature';
  if r.value is not null or r.zones_used <> 2 or (r.inputs->1->>'value') is not null then raise exception 'FAIL: 13:00 flagged %', r; end if;
  -- Other measurements at 12:00 are complete: RH = mean(71, 72, 73) = 72.
  if (select value from public.crop_climate_hourly(a, '2026-10-10 16:00+00', '2026-10-10 17:00+00') where metric = 'relative_humidity') <> 72 then
    raise exception 'FAIL: RH 12:00';
  end if;

  -- Radiation: the one greenhouse-wide reading, for B too (Zone 4 only), not summed or averaged over zones.
  if (select value from public.crop_climate_hourly(b, '2026-10-10 22:00+00', '2026-10-10 23:00+00') where metric = 'radiation_sum') <> 342.9
     or (select value from public.crop_climate_hourly(a, '2026-10-10 22:00+00', '2026-10-10 23:00+00') where metric = 'radiation_sum') <> 342.9
     or (select count(*) from public.crop_climate_hourly(a, '2026-10-10 22:00+00', '2026-10-10 23:00+00') where metric = 'radiation_sum') <> 1 then
    raise exception 'FAIL: shared radiation';
  end if;

  -- Daily, Variety A, 10 Oct.
  -- Temperature: mean of the 22 hours with a value (12:00 and 13:00 have none) → partial.
  select * into r from public.crop_climate_daily(a, '2026-10-10', '2026-10-11') where local_date = '2026-10-10' and metric = 'air_temperature';
  if r.status <> 'partial' or r.hours <> 22 or round(r.value::numeric, 3) <> round((select avg(22 + h / 10.0) from generate_series(0, 23) h where h not in (12, 13))::numeric, 3) then
    raise exception 'FAIL: daily temperature %', r;
  end if;
  -- Irrigation: the 23:00 combined value = mean(150, 300, 450) = 300; never a sum of the day's snapshots.
  select * into r from public.crop_climate_daily(a, '2026-10-10', '2026-10-11') where local_date = '2026-10-10' and metric = 'irrigation_cumulative';
  if r.status <> 'final' or r.value <> 300 then raise exception 'FAIL: irrigation 10 Oct %', r; end if;
  -- Variety B (Zone 4): 600 at 23:00; its 15:00 hour (Zone 4 missing) is empty, not 0.
  if (select value from public.crop_climate_daily(b, '2026-10-10', '2026-10-10') where metric = 'irrigation_cumulative') <> 600 then raise exception 'FAIL: B irrigation'; end if;
  if (select value from public.crop_climate_hourly(b, '2026-10-10 19:00+00', '2026-10-10 20:00+00') where metric = 'irrigation_cumulative') is not null then
    raise exception 'FAIL: B 15:00 irrigation should be empty';
  end if;
  -- Radiation: 342.9 at 23:00, restart at 08:00 (00:00–07:00 held 9 Oct's 500).
  select * into r from public.crop_climate_daily(a, '2026-10-10', '2026-10-11') where local_date = '2026-10-10' and metric = 'radiation_sum';
  if r.status <> 'final' or r.value <> 342.9 or r.restart_hour <> 8 then raise exception 'FAIL: radiation 10 Oct %', r; end if;
  -- 11 Oct (past, no 23:00): incomplete; radiation running 25.0 at 12:00 (after its 08:00 restart), not 10 Oct's held 342.9.
  select * into r from public.crop_climate_daily(a, '2026-10-10', '2026-10-11') where local_date = '2026-10-11' and metric = 'radiation_sum';
  if r.status <> 'incomplete' or r.value is not null or r.running_value <> 25.0 or r.running_hour <> 12 or r.restart_hour <> 8 then
    raise exception 'FAIL: radiation 11 Oct %', r;
  end if;
  if (select status from public.crop_climate_daily(a, '2026-10-09', '2026-10-09') where metric = 'air_temperature') <> 'partial'
     or (select status from public.crop_climate_daily(a, '2026-10-05', '2026-10-05') where metric = 'air_temperature') <> 'no_data' then
    raise exception 'FAIL: partial/no-data days';
  end if;
end $$;
reset role;

-- ---------------------------------------------------------------------------
-- Area shares: weighted when every zone has one.
-- ---------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-4000-8000-0000000c5001","role":"authenticated"}', true);
select public.set_crop_climate_zones('aaaaaaaa-0000-4000-8000-0000000c5c01', '2026-10-10',
  (select jsonb_agg(jsonb_build_object('zone_id', id, 'area_share', case source_label when 'Zone 1' then 0.5 when 'Zone 2' then 0.25 else 0.25 end))
     from public.climate_zones where source_label in ('Zone 1', 'Zone 2', 'Zone 3')), 'zone areas measured');
do $$
declare r record;
begin
  -- 10:00: 0.5×22 + 0.25×23 + 0.25×24 = 22.75.
  select * into r from public.crop_climate_hourly('aaaaaaaa-0000-4000-8000-0000000c5c01', '2026-10-10 14:00+00', '2026-10-10 15:00+00') where metric = 'air_temperature';
  if r.method <> 'area_weighted' or round(r.value::numeric, 2) <> 22.75 then raise exception 'FAIL: weighted %', r; end if;
  -- 12:00, Zone 3 missing: 75 % of the area remains → value from Zones 1–2 renormalised: (0.5×21.2 + 0.25×22.2)/0.75.
  select * into r from public.crop_climate_hourly('aaaaaaaa-0000-4000-8000-0000000c5c01', '2026-10-10 16:00+00', '2026-10-10 17:00+00') where metric = 'air_temperature';
  if r.coverage <> 0.75 or round(r.value::numeric, 3) <> round((0.5 * 22.2 + 0.25 * 23.2) / 0.75, 3) then raise exception 'FAIL: weighted coverage %', r; end if;
end $$;
reset role;

-- ---------------------------------------------------------------------------
-- As of a moment: earlier zone assignments, no later files, no later reviews.
-- ---------------------------------------------------------------------------
do $$
declare
  a uuid := 'aaaaaaaa-0000-4000-8000-0000000c5c01';
  t0 timestamptz := (select v::timestamptz from t where k = 'before_change');
begin
  -- Before the area shares were recorded: the plain mean.
  if (select method from public.crop_climate_hourly(a, '2026-10-10 14:00+00', '2026-10-10 15:00+00', t0) where metric = 'air_temperature') <> 'mean' then
    raise exception 'FAIL: as-of assignment';
  end if;
  -- Before any file was received: nothing.
  if exists (select 1 from public.crop_climate_hourly(a, '2026-10-10', '2026-10-12', '2026-10-01')) then raise exception 'FAIL: as-of files'; end if;
end $$;

-- A corrected 10 Oct 23:00 export arrives later and is put into effect by review.
set local role service_role;
do $$
declare r jsonb;
begin
  r := pg_temp.ingest('10_23 corrected', pg_temp.parsed('2026-10-10 23:00', '999.9'));
  if r->>'status' <> 'conflict' then raise exception 'FAIL: expected conflict %', r; end if;
  insert into t values ('conflict', r->>'import_id');
end $$;
reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-4000-8000-0000000c5001","role":"authenticated"}', true);
select public.climate_review_file((select v::uuid from t where k = 'conflict'), 'activate', 'Corrected export');
reset role;
-- In one test transaction every default timestamp is the same; give the
-- history realistic times (test only, triggers off inside this rolled-back
-- transaction): exports received 12 Oct, the correction 19 Oct, reviewed 20 Oct.
set local session_replication_role = replica;
update public.climate_import_files set received_at = '2026-10-12 12:00+00' where id <> (select v::uuid from t where k = 'conflict');
update public.climate_import_files set received_at = '2026-10-19 12:00+00' where id = (select v::uuid from t where k = 'conflict');
update public.climate_file_reviews set reviewed_at = '2026-10-20 12:00+00';
set local session_replication_role = origin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-4000-8000-0000000c5001","role":"authenticated"}', true);
do $$
declare a uuid := 'aaaaaaaa-0000-4000-8000-0000000c5c01';
begin
  if (select value from public.crop_climate_daily(a, '2026-10-10', '2026-10-10') where metric = 'radiation_sum') <> 999.9 then raise exception 'FAIL: reviewed file not used now'; end if;
  -- Before the correction arrived, and after it arrived but before the review: the file in effect then.
  if (select value from public.crop_climate_daily(a, '2026-10-10', '2026-10-10', '2026-10-15') where metric = 'radiation_sum') <> 342.9
     or (select value from public.crop_climate_daily(a, '2026-10-10', '2026-10-10', '2026-10-19 18:00+00') where metric = 'radiation_sum') <> 342.9 then
    raise exception 'FAIL: as-of review';
  end if;
  if public.climate_file_state_at((select v::uuid from t where k = 'conflict'), '2026-10-19 18:00+00') <> 'conflict'
     or public.climate_file_state_at((select v::uuid from t where k = 'conflict'), '2026-10-15') is not null then
    raise exception 'FAIL: file state at';
  end if;
  -- One radiation value per hour, whichever file is in effect.
  if exists (select hour_utc from public.crop_climate_hourly(a, '2026-10-10', '2026-10-12') where metric = 'radiation_sum' group by hour_utc having count(*) > 1) then
    raise exception 'FAIL: two radiation values for an hour';
  end if;
end $$;
reset role;

-- Another organization sees nothing.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"bbbbbbbb-0000-4000-8000-0000000c5001","role":"authenticated"}', true);
do $$
begin
  if exists (select 1 from public.crop_climate_hourly('aaaaaaaa-0000-4000-8000-0000000c5c01', '2026-10-10', '2026-10-12')) then raise exception 'FAIL: B sees A''s climate'; end if;
end $$;
reset role;

select '{"result": "variety_climate tests passed"}';
rollback;
