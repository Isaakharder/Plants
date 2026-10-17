-- Plants: climate data received directly from the greenhouse climate computer.
--
-- Approved 2026-10-17 (Stage 1). Plants replaces CropLink as the climate-data
-- system: the GrowLinkAgent on the climate PC uploads every hourly Ridder
-- Synopta "Block Summary" CSV to the `climate` Edge Function, which parses it
-- and stores it here through climate_ingest_file(). Manual (historical) uploads
-- take the same path.
--
--   climate_sources          the climate computer (one per organization today)
--   climate_agent_keys       upload keys for the agent: only a SHA-256 hash is
--                            stored; the key is shown once when created
--   climate_zones            discovered from the CSV header; source_label
--                            ("Zone 8") is the identifier and never changes;
--                            display_name is optional
--   climate_import_files     every accepted file with its complete original
--                            bytes, how its hour was decided and its status
--                            (one active file per hour; a different file for
--                            the same hour is kept as a conflict for review;
--                            an unreadable file is kept as quarantined)
--   climate_readings         every original value from a parsed file, exactly
--                            as written (raw text, raw label and unit) with
--                            quality flags. Calculated summaries live elsewhere.
--   climate_import_attempts  every upload attempt and its outcome
--   crop_climate_zones       which zones a planting occupies, with effective
--                            dates and an optional share of its growing area;
--                            history is kept (bitemporal: valid dates + when
--                            it was recorded / superseded)
--
-- Nothing existing is changed: no existing table, function or policy is
-- altered, and nothing here is read by the forecast engine.

-- ---------------------------------------------------------------------------
-- Shared: history is never changed or removed
-- ---------------------------------------------------------------------------

create or replace function public.climate_history_immutable()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'Climate history cannot be changed or deleted (%)', tg_table_name using errcode = '42501';
end;
$$;

-- ---------------------------------------------------------------------------
-- Sources and agent keys
-- ---------------------------------------------------------------------------

create table public.climate_sources (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations (id) on delete restrict,
  kind             text not null default 'ridder_synopta_block_summary'
                     check (kind in ('ridder_synopta_block_summary')),
  name             text not null check (char_length(btrim(name)) between 1 and 100),
  -- Wall-clock time zone of the climate computer's exports.
  time_zone        text not null default 'America/Toronto',
  created_at       timestamptz not null default now(),
  created_by       uuid default auth.uid(),
  constraint climate_sources_org_name_key unique (organization_id, name),
  constraint climate_sources_organization_id_id_key unique (organization_id, id)
);

comment on table public.climate_sources is
  'A climate computer whose exports Plants receives (Ridder Synopta Block Summary).';

create table public.climate_agent_keys (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null,
  source_id        uuid not null,
  label            text not null check (char_length(btrim(label)) between 1 and 100),
  -- First characters of the key, shown so a key can be recognised; not secret.
  key_prefix       text not null unique,
  -- SHA-256 (hex) of the whole key. The key itself is never stored.
  key_hash         text not null unique check (key_hash ~ '^[0-9a-f]{64}$'),
  created_at       timestamptz not null default now(),
  created_by       uuid,
  expires_at       timestamptz,
  revoked_at       timestamptz,
  revoked_by       uuid,
  last_used_at     timestamptz,
  last_used_ip     text,
  constraint climate_agent_keys_source_fkey
    foreign key (organization_id, source_id)
    references public.climate_sources (organization_id, id) on delete restrict
);

comment on table public.climate_agent_keys is
  'Upload keys for the climate agent. Only a hash is kept; a key can upload climate files for its own source and nothing else.';

-- ---------------------------------------------------------------------------
-- Zones
-- ---------------------------------------------------------------------------

create table public.climate_zones (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null,
  source_id        uuid not null,
  -- Exactly as the climate computer labels the column ("Zone 8"). The identifier.
  source_label     text not null check (char_length(source_label) between 1 and 100),
  zone_number      integer generated always as (((regexp_match(source_label, '^[Zz]one\s*(\d+)$'))[1])::integer) stored,
  display_name     text check (display_name is null or char_length(btrim(display_name)) between 1 and 100),
  status           text not null default 'active' check (status in ('active', 'retired')),
  first_seen_hour  timestamptz,
  last_seen_hour   timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint climate_zones_source_label_key unique (source_id, source_label),
  constraint climate_zones_organization_id_id_key unique (organization_id, id),
  constraint climate_zones_source_fkey
    foreign key (organization_id, source_id)
    references public.climate_sources (organization_id, id) on delete restrict
);

comment on table public.climate_zones is
  'Climate zones discovered from the export header. source_label is the identifier and never changes; display_name is an optional friendly name.';

create or replace function public.climate_zones_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Climate zones cannot be deleted (retire them instead)' using errcode = '42501';
  end if;
  if new.source_label is distinct from old.source_label
     or new.source_id is distinct from old.source_id
     or new.organization_id is distinct from old.organization_id then
    raise exception 'A climate zone''s source label cannot be changed' using errcode = '42501';
  end if;
  new.updated_at := now();
  return new;
end;
$$;

create trigger climate_zones_guard before update or delete on public.climate_zones
  for each row execute function public.climate_zones_guard();

-- ---------------------------------------------------------------------------
-- Imported files and their readings
-- ---------------------------------------------------------------------------

create table public.climate_import_files (
  id                    uuid primary key default gen_random_uuid(),
  organization_id       uuid not null,
  source_id             uuid not null,
  -- The complete original file, byte for byte, and its SHA-256 (hex).
  sha256                text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  raw_bytes             bytea not null,
  byte_size             integer generated always as (octet_length(raw_bytes)) stored,
  original_filename     text not null check (char_length(original_filename) between 1 and 255),
  encoding              text,
  channel               text not null check (channel in ('agent', 'manual')),
  agent_key_id          uuid references public.climate_agent_keys (id) on delete restrict,
  uploaded_by           uuid,
  agent_version         text check (char_length(agent_version) <= 50),
  received_at           timestamptz not null default now(),
  parser_version        text not null,
  parse_status          text not null check (parse_status in ('parsed', 'quarantined')),
  -- Why a file was quarantined, and warnings that didn't stop it: [{code, message}].
  problems              jsonb not null default '[]'::jsonb,
  warnings              jsonb not null default '[]'::jsonb,
  -- What the file says about its own time, verbatim.
  filename_local        text,
  system_date_raw       text,
  system_time_raw       text,
  week_number_raw       text,
  metadata              jsonb not null default '{}'::jsonb,
  -- The hour this file describes (null while quarantined) and how it was decided.
  hour_utc              timestamptz,
  hour_local            text,
  time_method           text check (time_method in ('filename', 'system', 'review')),
  date_order            text check (date_order in ('MDY', 'DMY', 'either')),
  clock_offset_minutes  numeric(6, 1),
  -- active: the hour's file; conflict: a different file for an hour that already
  -- has one (kept for review, not used); superseded: replaced at review;
  -- none: quarantined (no hour yet).
  hour_state            text not null check (hour_state in ('active', 'conflict', 'superseded', 'none')),
  reviewed_at           timestamptz,
  reviewed_by           uuid,
  review_note           text check (char_length(review_note) <= 500),
  constraint climate_import_files_sha_key unique (organization_id, sha256),
  constraint climate_import_files_source_fkey
    foreign key (organization_id, source_id)
    references public.climate_sources (organization_id, id) on delete restrict,
  constraint climate_import_files_hour_check
    check ((parse_status = 'parsed') = (hour_utc is not null)
       and (parse_status = 'quarantined') = (hour_state = 'none')),
  constraint climate_import_files_size_check check (octet_length(raw_bytes) between 1 and 1048576)
);

-- One active file per source and hour.
create unique index climate_import_files_active_hour_key
  on public.climate_import_files (source_id, hour_utc) where hour_state = 'active';
create index climate_import_files_source_hour_idx on public.climate_import_files (source_id, hour_utc);
create index climate_import_files_review_idx on public.climate_import_files (source_id, received_at desc)
  where hour_state in ('conflict', 'none');

comment on table public.climate_import_files is
  'Every accepted climate export with its complete original bytes. Never deleted; only the review fields and hour_state change.';

-- The original file and how it was read never change; only review decisions do.
create or replace function public.climate_import_files_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Climate import files cannot be deleted' using errcode = '42501';
  end if;
  -- byte_size is generated (not yet computed in NEW); raw_bytes is compared itself.
  if (to_jsonb(new) - array['hour_state', 'reviewed_at', 'reviewed_by', 'review_note',
                            'hour_utc', 'hour_local', 'time_method', 'parse_status', 'byte_size'])
     is distinct from
     (to_jsonb(old) - array['hour_state', 'reviewed_at', 'reviewed_by', 'review_note',
                            'hour_utc', 'hour_local', 'time_method', 'parse_status', 'byte_size']) then
    raise exception 'A climate import file''s original content cannot be changed' using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger climate_import_files_guard before update or delete on public.climate_import_files
  for each row execute function public.climate_import_files_guard();

create table public.climate_readings (
  id               bigint generated always as identity primary key,
  organization_id  uuid not null,
  source_id        uuid not null,
  file_id          uuid not null references public.climate_import_files (id) on delete restrict,
  zone_id          uuid not null references public.climate_zones (id) on delete restrict,
  -- The file's hour (copied for indexing).
  hour_utc         timestamptz not null,
  -- The row label exactly as exported, e.g. 'Air temperature [°C]'.
  row_label        text not null,
  -- Normalised metric: air_temperature, relative_humidity, co2, radiation_sum,
  -- ec, ph, irrigation_cumulative, drain_percentage, group_activation_time, unknown.
  metric           text not null,
  -- Canonical unit when the exported unit is the expected one; unit_raw as exported.
  unit             text,
  unit_raw         text,
  -- The cell exactly as exported, and its number (null when not numeric).
  raw_text         text not null,
  value            double precision,
  flags            text[] not null default '{}',
  constraint climate_readings_file_zone_row_key unique (file_id, zone_id, row_label)
);

create index climate_readings_zone_metric_hour_idx on public.climate_readings (zone_id, metric, hour_utc);
create index climate_readings_source_hour_idx on public.climate_readings (source_id, hour_utc);

comment on table public.climate_readings is
  'Original climate values, one per file, zone and exported row, exactly as exported. Append-only. Use climate_readings_active for the hour''s accepted file.';

create trigger climate_readings_immutable before update or delete on public.climate_readings
  for each row execute function public.climate_history_immutable();

create table public.climate_import_attempts (
  id               bigint generated always as identity primary key,
  organization_id  uuid,
  source_id        uuid,
  file_id          uuid references public.climate_import_files (id) on delete restrict,
  sha256           text,
  filename         text,
  channel          text not null check (channel in ('agent', 'manual')),
  agent_key_id     uuid,
  uploaded_by      uuid,
  outcome          text not null check (outcome in ('created', 'duplicate', 'conflict', 'quarantined')),
  detail           jsonb not null default '{}'::jsonb,
  created_at       timestamptz not null default now()
);

create index climate_import_attempts_source_idx on public.climate_import_attempts (source_id, created_at desc);

comment on table public.climate_import_attempts is
  'Every accepted upload and its outcome (created, duplicate, conflict, quarantined). Append-only.';

create trigger climate_import_attempts_immutable before update or delete on public.climate_import_attempts
  for each row execute function public.climate_history_immutable();

-- The readings of each hour's accepted file.
create view public.climate_readings_active
with (security_invoker = true) as
  select r.*
  from public.climate_readings r
  join public.climate_import_files f on f.id = r.file_id
  where f.hour_state = 'active';

-- ---------------------------------------------------------------------------
-- Planting ↔ zone assignments
-- ---------------------------------------------------------------------------

create table public.crop_climate_zones (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null,
  crop_id          uuid not null,
  zone_id          uuid not null,
  -- Valid time: the planting occupies the zone from valid_from up to (not
  -- including) valid_until; null = open-ended.
  valid_from       date not null,
  valid_until      date,
  -- Optional share of the planting's growing area in this zone (0–1].
  area_share       numeric(5, 4) check (area_share is null or (area_share > 0 and area_share <= 1)),
  -- Rows written together by one change.
  change_id        uuid not null,
  reason           text check (char_length(reason) <= 500),
  -- Knowledge time: when this was recorded and when a later change replaced it.
  recorded_at      timestamptz not null default now(),
  recorded_by      uuid,
  superseded_at    timestamptz,
  superseded_by    uuid,
  constraint crop_climate_zones_crop_fkey
    foreign key (organization_id, crop_id)
    references public.crops (organization_id, id) on delete restrict,
  constraint crop_climate_zones_zone_fkey
    foreign key (organization_id, zone_id)
    references public.climate_zones (organization_id, id) on delete restrict,
  constraint crop_climate_zones_valid_check check (valid_until is null or valid_until > valid_from)
);

create index crop_climate_zones_crop_idx on public.crop_climate_zones (crop_id, valid_from) where superseded_at is null;

comment on table public.crop_climate_zones is
  'Which climate zones a planting occupies, with effective dates and optional area share. Never edited: a change supersedes rows (superseded_at) and adds new ones, so any past state can be reproduced.';

-- Only marking a row superseded is allowed, once.
create or replace function public.crop_climate_zones_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Zone assignments cannot be deleted' using errcode = '42501';
  end if;
  if old.superseded_at is not null
     or (to_jsonb(new) - array['superseded_at', 'superseded_by']) is distinct from (to_jsonb(old) - array['superseded_at', 'superseded_by'])
     or new.superseded_at is null then
    raise exception 'Zone assignments can only be superseded, not edited' using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger crop_climate_zones_guard before update or delete on public.crop_climate_zones
  for each row execute function public.crop_climate_zones_guard();

-- ---------------------------------------------------------------------------
-- Row level security: members read; all writes go through the functions below.
-- ---------------------------------------------------------------------------

alter table public.climate_sources enable row level security;
alter table public.climate_agent_keys enable row level security;
alter table public.climate_zones enable row level security;
alter table public.climate_import_files enable row level security;
alter table public.climate_readings enable row level security;
alter table public.climate_import_attempts enable row level security;
alter table public.crop_climate_zones enable row level security;

create policy "Members can read climate sources" on public.climate_sources
  for select to authenticated using (public.is_org_member(organization_id));
create policy "Owners can read climate agent keys" on public.climate_agent_keys
  for select to authenticated using (public.is_org_owner(organization_id));
create policy "Members can read climate zones" on public.climate_zones
  for select to authenticated using (public.is_org_member(organization_id));
create policy "Members can read climate files" on public.climate_import_files
  for select to authenticated using (public.is_org_member(organization_id));
create policy "Members can read climate readings" on public.climate_readings
  for select to authenticated using (public.is_org_member(organization_id));
create policy "Members can read climate import attempts" on public.climate_import_attempts
  for select to authenticated using (public.is_org_member(organization_id));
create policy "Members can read zone assignments" on public.crop_climate_zones
  for select to authenticated using (public.is_org_member(organization_id));

revoke all on public.climate_sources, public.climate_agent_keys, public.climate_zones,
  public.climate_import_files, public.climate_readings, public.climate_import_attempts,
  public.crop_climate_zones, public.climate_readings_active
  from anon, authenticated;
grant select on public.climate_sources, public.climate_zones, public.climate_import_files,
  public.climate_readings, public.climate_import_attempts, public.crop_climate_zones,
  public.climate_readings_active
  to authenticated;
-- The climate Edge Function (service role) reads a source's time zone; everything
-- else it does goes through the functions below. Explicit, not left to defaults.
grant select on public.climate_sources to service_role;
-- The key hash is never readable from the app.
grant select (id, organization_id, source_id, label, key_prefix, created_at, created_by,
              expires_at, revoked_at, revoked_by, last_used_at)
  on public.climate_agent_keys to authenticated;

-- ---------------------------------------------------------------------------
-- Sources and keys (owners)
-- ---------------------------------------------------------------------------

create or replace function public.climate_create_source(p_organization_id uuid, p_name text)
returns public.climate_sources
language plpgsql
security definer
set search_path = ''
as $$
declare
  s public.climate_sources;
begin
  if not public.is_org_owner(p_organization_id) then
    raise exception 'Only an organization owner can add a climate source' using errcode = '42501';
  end if;
  insert into public.climate_sources (organization_id, name, created_by)
  values (p_organization_id, btrim(p_name), auth.uid())
  returning * into s;
  return s;
end;
$$;

-- Returns the new key once; only its hash is stored.
create or replace function public.climate_create_agent_key(p_source_id uuid, p_label text, p_expires_at timestamptz default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid;
  v_prefix text;
  v_key text;
  v_id uuid;
begin
  select organization_id into v_org from public.climate_sources where id = p_source_id;
  if v_org is null or not public.is_org_owner(v_org) then
    raise exception 'Only an organization owner can create an agent key' using errcode = '42501';
  end if;
  if p_expires_at is not null and p_expires_at <= now() then
    raise exception 'The expiry must be in the future' using errcode = '22023';
  end if;
  -- gen_random_uuid() is a v4 UUID from the server's cryptographic random source:
  -- three of them give 10 prefix characters and 244 random bits of secret.
  v_prefix := substr(replace(gen_random_uuid()::text, '-', ''), 1, 10);
  v_key := 'plk_' || v_prefix || '_' || replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
  insert into public.climate_agent_keys (organization_id, source_id, label, key_prefix, key_hash, created_by, expires_at)
  values (v_org, p_source_id, btrim(p_label), v_prefix, encode(sha256(convert_to(v_key, 'UTF8')), 'hex'), auth.uid(), p_expires_at)
  returning id into v_id;
  return jsonb_build_object('id', v_id, 'key_prefix', v_prefix, 'key', v_key);
end;
$$;

create or replace function public.climate_revoke_agent_key(p_key_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid;
begin
  select organization_id into v_org from public.climate_agent_keys where id = p_key_id;
  if v_org is null or not public.is_org_owner(v_org) then
    raise exception 'Only an organization owner can revoke an agent key' using errcode = '42501';
  end if;
  update public.climate_agent_keys
     set revoked_at = coalesce(revoked_at, now()), revoked_by = coalesce(revoked_by, auth.uid())
   where id = p_key_id;
end;
$$;

-- Server only: the key's source when it is valid (null otherwise); records its use.
create or replace function public.climate_agent_authenticate(p_key text, p_ip text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  k record;
begin
  if p_key is null or p_key !~ '^plk_[0-9a-f]{10}_[0-9a-f]{64}$' then
    return null;
  end if;
  select ak.id, ak.organization_id, ak.source_id, ak.label, s.name as source_name, o.name as organization_name
    into k
    from public.climate_agent_keys ak
    join public.climate_sources s on s.id = ak.source_id
    join public.organizations o on o.id = ak.organization_id
   where ak.key_hash = encode(sha256(convert_to(p_key, 'UTF8')), 'hex')
     and ak.revoked_at is null
     and (ak.expires_at is null or ak.expires_at > now());
  if not found then
    return null;
  end if;
  update public.climate_agent_keys set last_used_at = now(), last_used_ip = left(p_ip, 100) where id = k.id;
  return jsonb_build_object('key_id', k.id, 'organization_id', k.organization_id, 'source_id', k.source_id,
                            'key_label', k.label, 'source_name', k.source_name, 'organization_name', k.organization_name);
end;
$$;

-- ---------------------------------------------------------------------------
-- Ingest (server only)
-- ---------------------------------------------------------------------------

-- Stores one export atomically: its original bytes, how it was read, its zones
-- and readings, and the attempt. Identical bytes are a duplicate (nothing new is
-- stored); a different file for an hour that already has one is kept as a
-- conflict for review; a file that can't be read is kept as quarantined.
-- p_parsed is the parser's output (see supabase/functions/_shared/climate).
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
  v_file_id    uuid;
  v_status     text := p_parsed->>'status';
  v_hour       timestamptz := nullif(p_parsed#>>'{time,hourUtc}', '')::timestamptz;
  v_state      text;
  v_outcome    text;
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

  select * into v_existing from public.climate_import_files where organization_id = v_org and sha256 = p_sha256;
  if found then
    insert into public.climate_import_attempts (organization_id, source_id, file_id, sha256, filename, channel, agent_key_id, uploaded_by, outcome, detail)
    values (v_org, p_source_id, v_existing.id, p_sha256, p_filename, p_channel, p_agent_key_id, p_user_id, 'duplicate',
            jsonb_build_object('agent_version', p_agent_version));
    return jsonb_build_object('status', 'duplicate', 'import_id', v_existing.id,
                              'hour_utc', to_char(v_existing.hour_utc at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
                              'hour_local', v_existing.hour_local, 'file_status', v_existing.hour_state);
  end if;

  if v_status = 'quarantined' then
    v_state := 'none';
    v_outcome := 'quarantined';
  elsif exists (select 1 from public.climate_import_files where source_id = p_source_id and hour_utc = v_hour and hour_state = 'active') then
    v_state := 'conflict';
    v_outcome := 'conflict';
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
          jsonb_build_object('agent_version', p_agent_version, 'readings', v_readings));

  return jsonb_build_object('status', v_outcome, 'import_id', v_file_id,
                            'hour_utc', to_char(v_hour at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
                            'hour_local', p_parsed#>>'{time,hourLocal}', 'readings', v_readings,
                            'file_status', v_state);
end;
$$;

-- ---------------------------------------------------------------------------
-- Planting ↔ zone assignments
-- ---------------------------------------------------------------------------

-- From p_from on, the planting occupies exactly p_zones ([{zone_id, area_share?}],
-- empty = no zones). Earlier history is kept: rows that reach past p_from are
-- superseded and re-recorded up to p_from. Area shares: none, or all of them
-- summing to 1.
create or replace function public.set_crop_climate_zones(p_crop_id uuid, p_from date, p_zones jsonb, p_reason text default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org      uuid;
  v_planted  date;
  v_pulled   date;
  v_change   uuid := gen_random_uuid();
  -- Statement-independent clock: two changes in one transaction stay ordered.
  v_now      timestamptz := clock_timestamp();
  v_n        integer;
  v_shares   integer;
  v_sum      numeric;
  r          public.crop_climate_zones;
begin
  select organization_id, planting_date, pullout_date into v_org, v_planted, v_pulled
    from public.crops where id = p_crop_id;
  if v_org is null or not public.is_org_owner(v_org) then
    raise exception 'Only an organization owner can change climate zones' using errcode = '42501';
  end if;
  if p_from is null or p_from < v_planted or p_from >= v_pulled then
    raise exception 'The start date must be within the planting (% to %)', v_planted, v_pulled using errcode = '22023';
  end if;
  if jsonb_typeof(coalesce(p_zones, '[]'::jsonb)) <> 'array' then
    raise exception 'Zones must be a list' using errcode = '22023';
  end if;

  select count(*), count(z->>'area_share'), coalesce(sum((z->>'area_share')::numeric), 0)
    into v_n, v_shares, v_sum
    from jsonb_array_elements(coalesce(p_zones, '[]'::jsonb)) z;
  if v_n <> (select count(distinct z->>'zone_id') from jsonb_array_elements(coalesce(p_zones, '[]'::jsonb)) z) then
    raise exception 'A zone is listed twice' using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_array_elements(coalesce(p_zones, '[]'::jsonb)) z
              where not exists (select 1 from public.climate_zones cz
                                 where cz.id = (z->>'zone_id')::uuid and cz.organization_id = v_org)) then
    raise exception 'Unknown climate zone' using errcode = '22023';
  end if;
  if v_shares > 0 and (v_shares <> v_n or abs(v_sum - 1) > 0.0001) then
    raise exception 'Area shares must be given for every zone and add up to 100%%' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('crop_climate_zones:' || p_crop_id::text, 0));

  -- Current rows that reach p_from or later are replaced from p_from on.
  for r in
    select * from public.crop_climate_zones
     where crop_id = p_crop_id and superseded_at is null
       and (valid_until is null or valid_until > p_from)
  loop
    update public.crop_climate_zones set superseded_at = v_now, superseded_by = v_change where id = r.id;
    if r.valid_from < p_from then
      insert into public.crop_climate_zones (organization_id, crop_id, zone_id, valid_from, valid_until, area_share, change_id, reason, recorded_at, recorded_by)
      values (r.organization_id, r.crop_id, r.zone_id, r.valid_from, p_from, r.area_share, v_change, r.reason, v_now, auth.uid());
    end if;
  end loop;

  insert into public.crop_climate_zones (organization_id, crop_id, zone_id, valid_from, valid_until, area_share, change_id, reason, recorded_at, recorded_by)
  select v_org, p_crop_id, (z->>'zone_id')::uuid, p_from, null, (z->>'area_share')::numeric, v_change, left(p_reason, 500), v_now, auth.uid()
    from jsonb_array_elements(coalesce(p_zones, '[]'::jsonb)) z;

  return v_change;
end;
$$;

-- The zones a planting occupied on p_date, as recorded at p_as_of (default: as currently recorded).
create or replace function public.crop_climate_zones_at(p_crop_id uuid, p_date date, p_as_of timestamptz default 'infinity')
returns table (zone_id uuid, source_label text, area_share numeric, valid_from date, valid_until date, assignment_id uuid)
language sql
stable
security invoker
set search_path = ''
as $$
  select a.zone_id, z.source_label, a.area_share, a.valid_from, a.valid_until, a.id
    from public.crop_climate_zones a
    join public.climate_zones z on z.id = a.zone_id
   where a.crop_id = p_crop_id
     and a.recorded_at <= p_as_of
     and (a.superseded_at is null or a.superseded_at > p_as_of)
     and a.valid_from <= p_date
     and (a.valid_until is null or a.valid_until > p_date)
   order by z.zone_number nulls last, z.source_label;
$$;

-- The only way a planting's climate is read: each accepted reading in
-- [p_from, p_to) from a zone the planting occupied on that reading's local date
-- (as recorded at p_as_of), with that zone's area share. Readings from other
-- zones are never returned.
create or replace function public.crop_climate_readings(p_crop_id uuid, p_from timestamptz, p_to timestamptz, p_as_of timestamptz default 'infinity')
returns table (hour_utc timestamptz, zone_id uuid, source_label text, area_share numeric, metric text, unit text, value double precision, flags text[], reading_id bigint)
language sql
stable
security invoker
set search_path = ''
as $$
  select r.hour_utc, r.zone_id, z.source_label, a.area_share, r.metric, r.unit, r.value, r.flags, r.id
    from public.crops c
    join public.crop_climate_zones a on a.crop_id = c.id
    join public.climate_zones z on z.id = a.zone_id
    join public.climate_sources s on s.id = z.source_id
    join public.climate_readings_active r on r.zone_id = a.zone_id
   where c.id = p_crop_id
     and r.hour_utc >= p_from and r.hour_utc < p_to
     and a.recorded_at <= p_as_of
     and (a.superseded_at is null or a.superseded_at > p_as_of)
     and a.valid_from <= (r.hour_utc at time zone s.time_zone)::date
     and (a.valid_until is null or a.valid_until > (r.hour_utc at time zone s.time_zone)::date)
   order by r.hour_utc, z.zone_number nulls last, r.metric;
$$;

revoke execute on function public.climate_history_immutable(), public.climate_zones_guard(),
  public.climate_import_files_guard(), public.crop_climate_zones_guard()
  from public, anon, authenticated;
revoke execute on function public.climate_agent_authenticate(text, text),
  public.climate_ingest_file(uuid, text, uuid, uuid, text, text, text, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.climate_agent_authenticate(text, text),
  public.climate_ingest_file(uuid, text, uuid, uuid, text, text, text, text, jsonb)
  to service_role;
revoke execute on function public.climate_create_source(uuid, text),
  public.climate_create_agent_key(uuid, text, timestamptz), public.climate_revoke_agent_key(uuid),
  public.set_crop_climate_zones(uuid, date, jsonb, text),
  public.crop_climate_zones_at(uuid, date, timestamptz),
  public.crop_climate_readings(uuid, timestamptz, timestamptz, timestamptz)
  from public, anon;
grant execute on function public.climate_create_source(uuid, text),
  public.climate_create_agent_key(uuid, text, timestamptz), public.climate_revoke_agent_key(uuid),
  public.set_crop_climate_zones(uuid, date, jsonb, text),
  public.crop_climate_zones_at(uuid, date, timestamptz),
  public.crop_climate_readings(uuid, timestamptz, timestamptz, timestamptz)
  to authenticated;
