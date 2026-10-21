-- Climate: six measurements, and daily values from running totals
--
-- Requested 2026-10-21. Plants now uses only six measurements from the
-- Ridder Synopta Block Summary export:
--   air temperature, RH, CO₂             per zone, hourly; daily mean of valid hours
--   cumulative irrigation (ml/dripper)   per zone, running total since midnight;
--                                        the day's value is the 23:00 reading
--   radiation sum (J/cm²)                greenhouse-wide (cell B6, column B "Zone 1");
--                                        the day's value is the 23:00 reading
--   cumulative drain (%)                 greenhouse-wide (cell B10, column B);
--                                        the day's value is the 22:00 reading
-- Running totals are never summed or averaged; without the final file a day
-- is "running" (today) or "incomplete" (past).
--
-- Conventions confirmed in production (read-only, 2026-10-21, 272 files):
--   * every file has the same header, Zone 1 … Zone 22 in columns B … W;
--   * radiation does NOT restart at midnight: 00:00–07:00 hold the previous
--     day's total and it restarts at 08:00 (all 12 days); Zone 15 repeats it;
--   * drain restarts at 00:00 or 01:00 (the 00:00 file can still hold the
--     previous day); Zone 15 has a different drain figure (not used);
--   * irrigation restarts at 00:00 in every zone and its 23:00 reading is the
--     day's maximum on all 242 zone-days that have one;
--   * files are named for the whole hour; System time is within a minute.
-- A day's running value only counts readings after that day's restart (the
-- first fall of the counter on that date); earlier readings of the date
-- belong to the previous day.
--
-- Original records are untouched: readings of other rows (EC, pH, group
-- activation time) and Zone 15's radiation and drain stay in climate_readings
-- and in the stored files; they are left out of climate_readings_active, which
-- every calculation reads. Nothing is stored for daily values: they are read
-- from the active files, so history is corrected as soon as this is deployed.
-- Duplicate protection keeps working for older files: identical bytes as
-- before, and a second fingerprint (version 2, the six measurements only) is
-- added for every stored file, by insert.

-- ---------------------------------------------------------------------------
-- The six measurements
-- ---------------------------------------------------------------------------

create or replace function public.climate_is_measurement(p_metric text, p_zone_label text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_metric in ('air_temperature', 'relative_humidity', 'co2', 'irrigation_cumulative')
      or (p_metric in ('radiation_sum', 'drain_percentage') and p_zone_label = 'Zone 1')
$$;

-- Same columns as before; only the six measurements of each hour's file in effect.
create or replace view public.climate_readings_active
with (security_invoker = true) as
  select r.*
  from public.climate_readings r
  join public.climate_import_files f on f.id = r.file_id
  join public.climate_zones z on z.id = r.zone_id
  where f.hour_state = 'active'
    and public.climate_is_measurement(r.metric, z.source_label);

-- The greenhouse-wide column (B) of a source.
create or replace function public.climate_greenhouse_zone_id(p_source_id uuid)
returns uuid
language sql
stable
security invoker
set search_path = ''
as $$
  select id from public.climate_zones where source_id = p_source_id and source_label = 'Zone 1'
$$;

-- ---------------------------------------------------------------------------
-- Fingerprint version 2: the six measurements only
-- ---------------------------------------------------------------------------

create or replace function public.climate_measurements_fingerprint(p_readings jsonb)
returns text
language sql
immutable
set search_path = ''
as $$
  select public.climate_readings_fingerprint(coalesce(jsonb_agg(x), '[]'::jsonb))
    from jsonb_array_elements(coalesce(p_readings, '[]'::jsonb)) x
   where public.climate_is_measurement(x->>'metric', x->>'zone')
$$;

-- Version 1 rows (all readings, 20261030) stay as they are.
alter table public.climate_file_contents add column fingerprint_version smallint not null default 1;
alter table public.climate_file_contents drop constraint climate_file_contents_pkey;
alter table public.climate_file_contents add primary key (file_id, fingerprint_version);
alter table public.climate_file_contents alter column fingerprint_version drop default;
drop index public.climate_file_contents_source_content_idx;
create index climate_file_contents_source_content_idx on public.climate_file_contents (source_id, fingerprint_version, content_sha256);
comment on column public.climate_file_contents.fingerprint_version is
  '1: every reading of the file (20261030); 2: the six measurements only (20261031), used for duplicates from then on.';

-- Version 2 for every stored file with readings (inserts only).
insert into public.climate_file_contents (file_id, fingerprint_version, organization_id, source_id, hour_utc, content_sha256, readings)
select f.id, 2, f.organization_id, f.source_id, f.hour_utc,
       public.climate_readings_fingerprint(jsonb_agg(jsonb_build_object('zone', z.source_label, 'row_label', r.row_label, 'raw_text', r.raw_text))),
       count(*)
  from public.climate_import_files f
  join public.climate_readings r on r.file_id = f.id
  join public.climate_zones z on z.id = r.zone_id
 where f.hour_utc is not null
   and public.climate_is_measurement(r.metric, z.source_label)
 group by f.id;

-- ---------------------------------------------------------------------------
-- Ingest and quarantine review: as in 20261030, with fingerprint version 2.
-- ---------------------------------------------------------------------------

create or replace function public.climate_ingest_file(
  p_source_id      uuid,
  p_channel        text,
  p_agent_key_id   uuid,
  p_user_id        uuid,
  p_filename       text,
  p_raw_base64     text,
  p_sha256         text,
  p_agent_version  text,
  p_parsed         jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org        uuid;
  v_raw        bytea;
  v_existing   public.climate_import_files;
  v_match      public.climate_import_files;
  v_file_id    uuid;
  v_status     text := p_parsed->>'status';
  v_hour       timestamptz := nullif(p_parsed#>>'{time,hourUtc}', '')::timestamptz;
  v_content    text;
  v_state      text;
  v_outcome    text;
  v_reason     text;
  v_matched    jsonb;
  v_readings   integer := 0;
begin
  select organization_id into v_org from public.climate_sources where id = p_source_id;
  if v_org is null then
    raise exception 'Unknown climate source' using errcode = '22023';
  end if;

  if p_channel = 'agent' then
    if not exists (select 1 from public.climate_agent_keys
                    where id = p_agent_key_id and source_id = p_source_id
                      and revoked_at is null and (expires_at is null or expires_at > now())) then
      raise exception 'Agent key not valid for this source' using errcode = '42501';
    end if;
  elsif p_channel = 'manual' then
    if not exists (select 1 from public.organization_members
                    where organization_id = v_org and user_id = p_user_id and role = 'owner') then
      raise exception 'Only an organization owner can import climate files' using errcode = '42501';
    end if;
  else
    raise exception 'Unknown channel %', p_channel using errcode = '22023';
  end if;

  v_raw := decode(p_raw_base64, 'base64');
  if encode(sha256(v_raw), 'hex') <> p_sha256 then
    raise exception 'The file''s bytes do not match its hash' using errcode = '22023';
  end if;
  if v_status is null or v_status not in ('parsed', 'quarantined') or (v_status = 'parsed') <> (v_hour is not null) then
    raise exception 'Invalid parse result' using errcode = '22023';
  end if;

  -- One ingest per source at a time: duplicates and same-hour files are decided safely.
  perform pg_advisory_xact_lock(hashtextextended('climate_ingest:' || p_source_id::text, 0));

  -- 1. The same bytes: nothing new.
  select * into v_existing from public.climate_import_files where organization_id = v_org and sha256 = p_sha256;
  if found then
    v_matched := public.climate_file_brief(v_existing);
    insert into public.climate_import_attempts (organization_id, source_id, file_id, sha256, filename, channel, agent_key_id, uploaded_by, outcome, detail)
    values (v_org, p_source_id, v_existing.id, p_sha256, p_filename, p_channel, p_agent_key_id, p_user_id, 'duplicate',
            jsonb_build_object('agent_version', p_agent_version, 'reason', 'same_bytes', 'matched', v_matched));
    return jsonb_build_object('status', 'duplicate', 'reason', 'same_bytes', 'matched', v_matched, 'import_id', v_existing.id,
                              'hour_utc', to_char(v_existing.hour_utc at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
                              'hour_local', v_existing.hour_local, 'file_status', v_existing.hour_state);
  end if;

  if v_status = 'parsed' then
    v_content := public.climate_measurements_fingerprint(p_parsed->'readings');

    -- 2. The same readings for the same hour (a re-saved copy): nothing new.
    --    The file in effect is named first.
    select f.* into v_match
      from public.climate_file_contents c join public.climate_import_files f on f.id = c.file_id
     where c.fingerprint_version = 2 and c.source_id = p_source_id and c.content_sha256 = v_content and c.hour_utc = v_hour
     order by (f.hour_state = 'active') desc, f.received_at
     limit 1;
    if found then
      v_matched := public.climate_file_brief(v_match);
      insert into public.climate_import_attempts (organization_id, source_id, file_id, sha256, filename, channel, agent_key_id, uploaded_by, outcome, detail)
      values (v_org, p_source_id, v_match.id, p_sha256, p_filename, p_channel, p_agent_key_id, p_user_id, 'duplicate',
              jsonb_build_object('agent_version', p_agent_version, 'reason', 'same_readings', 'matched', v_matched, 'content_sha256', v_content));
      return jsonb_build_object('status', 'duplicate', 'reason', 'same_readings', 'matched', v_matched, 'import_id', v_match.id,
                                'hour_utc', to_char(v_match.hour_utc at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
                                'hour_local', v_match.hour_local, 'file_status', v_match.hour_state);
    end if;

    -- 3. The same readings as a file of another hour: almost certainly a copy
    --    with the wrong hour. Kept (bytes and all), held for review, not used.
    select f.* into v_match
      from public.climate_file_contents c join public.climate_import_files f on f.id = c.file_id
     where c.fingerprint_version = 2 and c.source_id = p_source_id and c.content_sha256 = v_content and c.hour_utc <> v_hour
     order by (f.hour_state = 'active') desc, f.received_at
     limit 1;
    if found then
      v_matched := public.climate_file_brief(v_match);
      v_reason := 'same_readings_as_other_hour';
      p_parsed := jsonb_set(p_parsed, '{problems}', coalesce(p_parsed->'problems', '[]'::jsonb) || jsonb_build_array(jsonb_build_object(
        'code', 'same_readings_as_other_hour',
        'message', format('Every reading is identical to the %s file (%s). Held for review instead of being used for %s.',
                          left(v_match.hour_local, 16), v_match.original_filename, left(p_parsed#>>'{time,hourLocal}', 16)))));
      p_parsed := jsonb_set(p_parsed, '{time,hourUtc}', 'null'::jsonb);
      v_status := 'quarantined';
      v_hour := null;
    end if;
  end if;

  if v_status = 'quarantined' then
    v_state := 'none';
    v_outcome := 'quarantined';
  elsif exists (select 1 from public.climate_import_files where source_id = p_source_id and hour_utc = v_hour and hour_state = 'active') then
    v_state := 'conflict';
    v_outcome := 'conflict';
    select * into v_match from public.climate_import_files where source_id = p_source_id and hour_utc = v_hour and hour_state = 'active';
    v_matched := public.climate_file_brief(v_match);
    v_reason := 'different_readings_same_hour';
  else
    v_state := 'active';
    v_outcome := 'created';
  end if;

  insert into public.climate_import_files (
    organization_id, source_id, sha256, raw_bytes, original_filename, encoding, channel, agent_key_id, uploaded_by,
    agent_version, parser_version, parse_status, problems, warnings, filename_local, system_date_raw, system_time_raw,
    week_number_raw, metadata, hour_utc, hour_local, time_method, date_order, clock_offset_minutes, hour_state)
  values (
    v_org, p_source_id, p_sha256, v_raw, left(p_filename, 255), p_parsed->>'encoding', p_channel, p_agent_key_id, p_user_id,
    left(p_agent_version, 50), p_parsed->>'parserVersion', v_status,
    coalesce(p_parsed->'problems', '[]'::jsonb), coalesce(p_parsed->'warnings', '[]'::jsonb),
    p_parsed#>>'{time,filenameLocal}', p_parsed#>>'{meta,systemDateRaw}', p_parsed#>>'{meta,systemTimeRaw}',
    p_parsed#>>'{meta,weekNumberRaw}', coalesce(p_parsed->'meta', '{}'::jsonb),
    v_hour, p_parsed#>>'{time,hourLocal}', p_parsed#>>'{time,method}', p_parsed#>>'{time,dateOrder}',
    nullif(p_parsed#>>'{time,clockOffsetMinutes}', '')::numeric, v_state)
  returning id into v_file_id;

  -- Zones named in the header (also for quarantined files, so new zones show up).
  insert into public.climate_zones (organization_id, source_id, source_label)
  select v_org, p_source_id, z->>'label'
    from jsonb_array_elements(coalesce(p_parsed->'zones', '[]'::jsonb)) z
  on conflict (source_id, source_label) do nothing;

  if v_status = 'parsed' then
    insert into public.climate_readings (organization_id, source_id, file_id, zone_id, hour_utc, row_label, metric, unit, unit_raw, raw_text, value, flags)
    select v_org, p_source_id, v_file_id, cz.id, v_hour, r.row_label, r.metric, r.unit, r.unit_raw, r.raw_text, r.value,
           coalesce(r.flags, '{}')
      from jsonb_to_recordset(coalesce(p_parsed->'readings', '[]'::jsonb))
           as r(zone text, row_label text, metric text, unit text, unit_raw text, raw_text text, value double precision, flags text[])
      join public.climate_zones cz on cz.source_id = p_source_id and cz.source_label = r.zone;
    get diagnostics v_readings = row_count;
    if v_readings <> jsonb_array_length(coalesce(p_parsed->'readings', '[]'::jsonb)) then
      raise exception 'Every reading must belong to a zone in the header' using errcode = '22023';
    end if;

    if v_readings > 0 then
      insert into public.climate_file_contents (file_id, fingerprint_version, organization_id, source_id, hour_utc, content_sha256, readings)
      values (v_file_id, 2, v_org, p_source_id, v_hour, v_content, v_readings);
    end if;

    if v_state = 'active' then
      update public.climate_zones cz
         set first_seen_hour = least(coalesce(cz.first_seen_hour, v_hour), v_hour),
             last_seen_hour = greatest(coalesce(cz.last_seen_hour, v_hour), v_hour)
       where cz.source_id = p_source_id
         and cz.source_label in (select z->>'label' from jsonb_array_elements(coalesce(p_parsed->'zones', '[]'::jsonb)) z);
    end if;
  end if;

  insert into public.climate_import_attempts (organization_id, source_id, file_id, sha256, filename, channel, agent_key_id, uploaded_by, outcome, detail)
  values (v_org, p_source_id, v_file_id, p_sha256, p_filename, p_channel, p_agent_key_id, p_user_id, v_outcome,
          jsonb_strip_nulls(jsonb_build_object('agent_version', p_agent_version, 'readings', v_readings, 'reason', v_reason, 'matched', v_matched)));

  return jsonb_strip_nulls(jsonb_build_object('status', v_outcome, 'reason', v_reason, 'matched', v_matched, 'import_id', v_file_id,
                            'hour_utc', to_char(v_hour at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
                            'hour_local', p_parsed#>>'{time,hourLocal}', 'readings', v_readings,
                            'file_status', v_state));
end;
$$;

-- ---------------------------------------------------------------------------
-- Review of a quarantined file: unchanged, and its readings' fingerprint is kept.
-- (An owner who assigns an hour has decided; the same-readings check isn't repeated.)
-- ---------------------------------------------------------------------------

create or replace function public.climate_resolve_quarantined_file(p_file_id uuid, p_user_id uuid, p_parsed jsonb, p_note text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  f         public.climate_import_files;
  v_hour    timestamptz := nullif(p_parsed#>>'{time,hourUtc}', '')::timestamptz;
  v_state   text;
  v_n       integer;
begin
  select * into f from public.climate_import_files where id = p_file_id;
  if f.id is null then
    raise exception 'Unknown climate file' using errcode = '22023';
  end if;
  if not exists (select 1 from public.organization_members
                  where organization_id = f.organization_id and user_id = p_user_id and role = 'owner') then
    raise exception 'Only an organization owner can review climate imports' using errcode = '42501';
  end if;
  if p_note is null or char_length(btrim(p_note)) = 0 then
    raise exception 'A note explaining the decision is required' using errcode = '22023';
  end if;
  if p_parsed->>'status' <> 'parsed' or v_hour is null or v_hour <> date_trunc('hour', v_hour) then
    raise exception 'The file still can''t be read with that hour' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('climate_ingest:' || f.source_id::text, 0));
  select * into f from public.climate_import_files where id = p_file_id;
  if f.hour_state <> 'none' then
    raise exception 'This file is no longer quarantined' using errcode = '22023';
  end if;

  v_state := case when exists (select 1 from public.climate_import_files
                                where source_id = f.source_id and hour_utc = v_hour and hour_state = 'active')
                  then 'conflict' else 'active' end;

  update public.climate_import_files
     set parse_status = 'parsed', hour_utc = v_hour, hour_local = p_parsed#>>'{time,hourLocal}', time_method = 'review',
         hour_state = v_state, reviewed_at = now(), reviewed_by = p_user_id, review_note = left(btrim(p_note), 500)
   where id = f.id;

  insert into public.climate_zones (organization_id, source_id, source_label)
  select f.organization_id, f.source_id, z->>'label'
    from jsonb_array_elements(coalesce(p_parsed->'zones', '[]'::jsonb)) z
  on conflict (source_id, source_label) do nothing;

  insert into public.climate_readings (organization_id, source_id, file_id, zone_id, hour_utc, row_label, metric, unit, unit_raw, raw_text, value, flags)
  select f.organization_id, f.source_id, f.id, cz.id, v_hour, r.row_label, r.metric, r.unit, r.unit_raw, r.raw_text, r.value, coalesce(r.flags, '{}')
    from jsonb_to_recordset(coalesce(p_parsed->'readings', '[]'::jsonb))
         as r(zone text, row_label text, metric text, unit text, unit_raw text, raw_text text, value double precision, flags text[])
    join public.climate_zones cz on cz.source_id = f.source_id and cz.source_label = r.zone;
  get diagnostics v_n = row_count;
  if v_n <> jsonb_array_length(coalesce(p_parsed->'readings', '[]'::jsonb)) or v_n = 0 then
    raise exception 'Every reading must belong to a zone in the header' using errcode = '22023';
  end if;

  insert into public.climate_file_contents (file_id, fingerprint_version, organization_id, source_id, hour_utc, content_sha256, readings)
  values (f.id, 2, f.organization_id, f.source_id, v_hour, public.climate_measurements_fingerprint(p_parsed->'readings'), v_n);

  if v_state = 'active' then
    update public.climate_zones cz
       set first_seen_hour = least(coalesce(cz.first_seen_hour, v_hour), v_hour),
           last_seen_hour = greatest(coalesce(cz.last_seen_hour, v_hour), v_hour)
     where cz.source_id = f.source_id
       and cz.source_label in (select z->>'label' from jsonb_array_elements(coalesce(p_parsed->'zones', '[]'::jsonb)) z);
  end if;

  insert into public.climate_file_reviews (organization_id, source_id, file_id, action, state_before, state_after, hour_utc, parser_version, note, reviewed_by)
  values (f.organization_id, f.source_id, f.id, 'resolve_quarantine', 'none', v_state, v_hour, p_parsed->>'parserVersion', left(btrim(p_note), 500), p_user_id);

  return jsonb_build_object('file_id', f.id, 'state', v_state, 'readings', v_n,
                            'hour_utc', to_char(v_hour at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'));
end;
$$;


-- ---------------------------------------------------------------------------
-- Daily values of running totals
-- ---------------------------------------------------------------------------

-- Per local date in [p_from, p_to]:
--   radiation_sum, drain_percentage   greenhouse-wide (zone_id = column B's zone)
--   irrigation_cumulative             per zone in p_zone_ids (null: every zone)
-- final_value: the reading of the final hour (23:00; drain 22:00) when that file
-- is in effect. status: final | running (today, final hour not passed) |
-- incomplete | no_data. running_value / running_hour: the latest reading after
-- the day's restart. restart_hour: when the counter restarted that day.
-- problems: counter_fell (it fell again after the restart).
create or replace function public.climate_daily_totals(p_source_id uuid, p_from date, p_to date, p_zone_ids uuid[] default null)
returns table (
  local_date     date,
  metric         text,
  zone_id        uuid,
  final_hour     integer,
  final_value    double precision,
  status         text,
  running_value  double precision,
  running_hour   integer,
  restart_hour   integer,
  problems       text[]
)
language sql
stable
security invoker
set search_path = ''
as $$
  with src as (
    select time_zone, public.climate_greenhouse_zone_id(id) as gw from public.climate_sources where id = p_source_id
  ),
  series(metric, zone_id, final_hour) as (
    select 'radiation_sum', (select gw from src), 23
    union all select 'drain_percentage', (select gw from src), 22
    union all select 'irrigation_cumulative', z.id, 23
      from public.climate_zones z
     where z.source_id = p_source_id and (p_zone_ids is null or z.id = any (p_zone_ids))
  ),
  r as (
    select a.metric, a.zone_id, a.hour_utc, (a.hour_utc at time zone (select time_zone from src)) as lt, a.value
      from public.climate_readings_active a
      join series se on se.metric = a.metric and se.zone_id = a.zone_id
     where a.source_id = p_source_id
       and a.value is not null
       and not (a.flags && array['not_numeric', 'unexpected_unit', 'out_of_range'])
       -- From one day earlier, so the first day's restart can be seen.
       and a.hour_utc >= ((p_from - 1)::timestamp at time zone (select time_zone from src))
       and a.hour_utc < ((p_to + 1)::timestamp at time zone (select time_zone from src))
       and p_to - p_from <= 400
  ),
  s as (
    select r.*, r.lt::date as d, extract(hour from r.lt)::integer as h,
           r.value < lag(r.value) over (partition by r.metric, r.zone_id order by r.hour_utc) - 0.05 as fell
      from r
  ),
  restarts as (
    select metric, zone_id, d, min(lt) as restart_lt, count(*) as falls from s where fell group by metric, zone_id, d
  ),
  days as (
    select g::date as d, se.metric, se.zone_id, se.final_hour
      from generate_series(p_from, p_to, interval '1 day') g cross join series se
     where se.zone_id is not null
  ),
  now_local as (
    select (now() at time zone (select time_zone from src)) as lt
  )
  select
    days.d, days.metric, days.zone_id, days.final_hour,
    fin.value,
    case
      when fin.value is not null then 'final'
      when days.d > (select lt::date from now_local) then 'running'
      when days.d = (select lt::date from now_local) and extract(hour from (select lt from now_local)) <= days.final_hour then 'running'
      when not exists (select 1 from s where s.metric = days.metric and s.zone_id = days.zone_id and s.d = days.d) then 'no_data'
      else 'incomplete'
    end,
    run.value, run.h,
    extract(hour from rs.restart_lt)::integer,
    case when rs.falls > 1 then array['counter_fell'] else '{}'::text[] end
  from days
  left join restarts rs on rs.metric = days.metric and rs.zone_id = days.zone_id and rs.d = days.d
  left join lateral (
    select s.value from s where s.metric = days.metric and s.zone_id = days.zone_id and s.d = days.d and s.h = days.final_hour
  ) fin on true
  left join lateral (
    select s.value, s.h from s
     where s.metric = days.metric and s.zone_id = days.zone_id and s.d = days.d and rs.restart_lt is not null and s.lt >= rs.restart_lt
     order by s.lt desc limit 1
  ) run on true
  order by days.d, days.metric, days.zone_id
$$;

-- Daily mean/min/max of the hourly measurements only (temperature, RH, CO₂):
-- running totals are never averaged.
create or replace function public.climate_daily(p_source_id uuid, p_zone_ids uuid[], p_metrics text[], p_from date, p_to date)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  with src as (select time_zone from public.climate_sources where id = p_source_id),
  r as (
    select r.zone_id, r.metric, (r.hour_utc at time zone (select time_zone from src))::date as d, r.value,
           (r.value is null or r.flags && array['out_of_range', 'not_numeric', 'unexpected_unit']) as excluded
      from public.climate_readings_active r
     where r.source_id = p_source_id
       and r.zone_id = any (p_zone_ids)
       and r.metric = any (p_metrics)
       and r.metric in ('air_temperature', 'relative_humidity', 'co2')
       and r.hour_utc >= (p_from::timestamp at time zone (select time_zone from src)) - interval '1 hour'
       and r.hour_utc < ((p_to + 1)::timestamp at time zone (select time_zone from src)) + interval '1 hour'
       and p_to - p_from <= 400
  ),
  days as (
    select zone_id, metric, d,
           count(*) filter (where not excluded) as n,
           avg(value) filter (where not excluded) as mean,
           min(value) filter (where not excluded) as mn,
           max(value) filter (where not excluded) as mx,
           count(*) filter (where excluded) as bad
      from r
     where d between p_from and p_to
     group by zone_id, metric, d
  )
  select coalesce(jsonb_agg(jsonb_build_object('zone_id', zone_id, 'metric', metric, 'days', days) order by zone_id, metric), '[]'::jsonb)
    from (
      select zone_id, metric,
             jsonb_agg(jsonb_build_array(d, n, round(mean::numeric, 3), mn, mx, bad) order by d) as days
        from days
       group by zone_id, metric
    ) x;
$$;

revoke execute on function public.climate_is_measurement(text, text), public.climate_measurements_fingerprint(jsonb) from public, anon;
grant execute on function public.climate_is_measurement(text, text) to authenticated;
revoke execute on function public.climate_greenhouse_zone_id(uuid), public.climate_daily_totals(uuid, date, date, uuid[]) from public, anon;
grant execute on function public.climate_greenhouse_zone_id(uuid), public.climate_daily_totals(uuid, date, date, uuid[]) to authenticated;
revoke execute on function public.climate_ingest_file(uuid, text, uuid, uuid, text, text, text, text, jsonb),
  public.climate_resolve_quarantined_file(uuid, uuid, jsonb, text)
  from public, anon, authenticated;
grant execute on function public.climate_ingest_file(uuid, text, uuid, uuid, text, text, text, text, jsonb),
  public.climate_resolve_quarantined_file(uuid, uuid, jsonb, text)
  to service_role;
