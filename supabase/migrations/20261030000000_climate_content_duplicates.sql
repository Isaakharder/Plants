-- Climate imports: duplicates recognised by their readings, not only by bytes
--
-- Requested 2026-10-21. Until now a duplicate was a file with the same bytes
-- (SHA-256). A re-saved copy (Excel, other line endings, an extra blank line)
-- has new bytes: for the same hour it became a conflict for review, and if it
-- was also renamed to another hour it was accepted as that hour, with copied
-- readings in effect. Now:
--   * same bytes                            duplicate (unchanged)
--   * same readings, same hour              duplicate: nothing new is stored,
--                                           the attempt names the file it matches
--   * same readings as another hour's file  held for review (quarantined, with
--                                           the problem same_readings_as_other_hour);
--                                           an owner can still assign it an hour
--   * otherwise                             created / conflict / quarantined as before
-- The System date/time check (parser synopta-block-summary/2) is in the Edge
-- Function: a file whose filename hour and System time disagree by more than
-- 15 minutes is quarantined.
--
-- "Same readings": every reading's zone label, exported row label and exact
-- cell text (climate_readings_fingerprint()); System date/time rows are not
-- readings, so a re-export of the same hour matches.
--
-- Audit 2026-10-21 (production, read-only): 177 files, all parsed and active,
-- no warnings, System time within ±1 minute of the filename, 177 distinct
-- reading sets (no two hours alike), 210 byte-identical re-uploads already
-- rejected. None of them changes state here.
--
-- Nothing existing is updated or deleted: fingerprints of existing files go in
-- a new append-only table. SHA-256 duplicates, one active file per hour, the
-- immutability triggers and the attempt log are kept as they are.

-- ---------------------------------------------------------------------------
-- Fingerprint of a file's readings
-- ---------------------------------------------------------------------------

-- p_readings: [{zone, row_label, raw_text, …}] (the parser's readings, or the
-- stored ones rebuilt in the same shape). Byte order (collate "C"), so the same
-- readings always give the same fingerprint.
create or replace function public.climate_readings_fingerprint(p_readings jsonb)
returns text
language sql
immutable
set search_path = ''
as $$
  select encode(sha256(convert_to(coalesce(string_agg(
           r.zone || chr(31) || r.row_label || chr(31) || r.raw_text, chr(30)
           order by r.zone collate "C", r.row_label collate "C", r.raw_text collate "C"), ''), 'UTF8')), 'hex')
    from jsonb_to_recordset(coalesce(p_readings, '[]'::jsonb)) as r(zone text, row_label text, raw_text text)
$$;

create table public.climate_file_contents (
  file_id          uuid primary key references public.climate_import_files (id) on delete restrict,
  organization_id  uuid not null,
  source_id        uuid not null,
  -- The hour the file's readings were stored for.
  hour_utc         timestamptz not null,
  content_sha256   text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  readings         integer not null check (readings > 0),
  computed_at      timestamptz not null default now()
);

create index climate_file_contents_source_content_idx on public.climate_file_contents (source_id, content_sha256);

comment on table public.climate_file_contents is
  'Append-only: the fingerprint of each stored file''s readings (climate_readings_fingerprint), to recognise re-saved copies and readings repeated at another hour.';

create trigger climate_file_contents_immutable before update or delete on public.climate_file_contents
  for each row execute function public.climate_history_immutable();

alter table public.climate_file_contents enable row level security;
create policy "Members can read climate file contents" on public.climate_file_contents
  for select to authenticated using (public.is_org_member(organization_id));
revoke all on public.climate_file_contents from anon, authenticated;
grant select on public.climate_file_contents to authenticated;

-- Existing files with readings (inserts only).
insert into public.climate_file_contents (file_id, organization_id, source_id, hour_utc, content_sha256, readings)
select f.id, f.organization_id, f.source_id, f.hour_utc,
       public.climate_readings_fingerprint(jsonb_agg(jsonb_build_object('zone', z.source_label, 'row_label', r.row_label, 'raw_text', r.raw_text))),
       count(*)
  from public.climate_import_files f
  join public.climate_readings r on r.file_id = f.id
  join public.climate_zones z on z.id = r.zone_id
 where f.hour_utc is not null
 group by f.id;

-- A file as the import answer describes it ("matches …").
create or replace function public.climate_file_brief(f public.climate_import_files)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object('file_id', f.id, 'filename', f.original_filename,
                            'received_at', to_char(f.received_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
                            'hour_local', f.hour_local, 'file_status', f.hour_state, 'channel', f.channel)
$$;

-- ---------------------------------------------------------------------------
-- Ingest (server only): same signature; the answer gains reason and matched.
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
    v_content := public.climate_readings_fingerprint(p_parsed->'readings');

    -- 2. The same readings for the same hour (a re-saved copy): nothing new.
    --    The file in effect is named first.
    select f.* into v_match
      from public.climate_file_contents c join public.climate_import_files f on f.id = c.file_id
     where c.source_id = p_source_id and c.content_sha256 = v_content and c.hour_utc = v_hour
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
     where c.source_id = p_source_id and c.content_sha256 = v_content and c.hour_utc <> v_hour
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
      insert into public.climate_file_contents (file_id, organization_id, source_id, hour_utc, content_sha256, readings)
      values (v_file_id, v_org, p_source_id, v_hour, v_content, v_readings);
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

  insert into public.climate_file_contents (file_id, organization_id, source_id, hour_utc, content_sha256, readings)
  values (f.id, f.organization_id, f.source_id, v_hour, public.climate_readings_fingerprint(p_parsed->'readings'), v_n);

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

-- Used inside the server-only functions above.
revoke execute on function public.climate_readings_fingerprint(jsonb), public.climate_file_brief(public.climate_import_files)
  from public, anon, authenticated;
revoke execute on function public.climate_ingest_file(uuid, text, uuid, uuid, text, text, text, text, jsonb),
  public.climate_resolve_quarantined_file(uuid, uuid, jsonb, text)
  from public, anon, authenticated;
grant execute on function public.climate_ingest_file(uuid, text, uuid, uuid, text, text, text, text, jsonb),
  public.climate_resolve_quarantined_file(uuid, uuid, jsonb, text)
  to service_role;
