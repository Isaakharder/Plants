-- Plants: climate review and monitoring (Stage 2).
--
-- Approved 2026-10-17. Adds, on top of 20261027000000_climate_ingest:
--
--   climate_file_reviews          append-only audit of every review decision:
--                                 which file, what changed (state before/after,
--                                 the file it replaced, the hour assigned), who,
--                                 when and why
--   climate_review_file()         owner: use a conflicting/superseded file for its
--                                 hour (the current one becomes superseded), or
--                                 set a conflicting file aside
--   climate_resolve_quarantined_file()
--                                 server (Edge Function, for a signed-in owner):
--                                 a quarantined file, re-read from its stored
--                                 bytes with a reviewer-assigned hour, gets its
--                                 readings; becomes active or a conflict
--   climate_series()              hourly values for chosen zones and metrics
--   climate_daily()               daily count / mean / min / max per zone & metric
--   climate_missing_hours()       hours without an accepted file
--   climate_import_status()       last successful import, counts, review queue
--   climate_set_zone_display_name()
--                                 owner: a zone's friendly name (its source
--                                 label never changes)
--   crop_climate_series()         a planting's hourly values: only from the
--                                 zones it occupied on each date (as recorded
--                                 at p_as_of), with their area shares
--
-- Reads return one JSON value (not rows) so long ranges aren't cut off by the
-- API's row limit. Original files and readings are never changed: a review only
-- moves which file is in effect for an hour, and records why.
-- Nothing existing is changed, and nothing here is read by the forecast engine.

-- ---------------------------------------------------------------------------
-- Review audit
-- ---------------------------------------------------------------------------

create table public.climate_file_reviews (
  id                bigint generated always as identity primary key,
  organization_id   uuid not null,
  source_id         uuid not null,
  file_id           uuid not null references public.climate_import_files (id) on delete restrict,
  action            text not null check (action in ('activate', 'set_aside', 'resolve_quarantine', 'superseded_by_review')),
  state_before      text not null,
  state_after       text not null,
  -- The file that was in effect for the hour and was replaced (activate), if any.
  replaced_file_id  uuid references public.climate_import_files (id) on delete restrict,
  hour_utc          timestamptz,
  parser_version    text,
  note              text not null check (char_length(btrim(note)) between 1 and 500),
  reviewed_by       uuid not null,
  reviewed_at       timestamptz not null default now()
);

create index climate_file_reviews_file_idx on public.climate_file_reviews (file_id, id);
create index climate_file_reviews_source_idx on public.climate_file_reviews (source_id, reviewed_at desc);

comment on table public.climate_file_reviews is
  'Append-only audit of climate import reviews: every change of which file is in effect for an hour, with who, when and why.';

create trigger climate_file_reviews_immutable before update or delete on public.climate_file_reviews
  for each row execute function public.climate_history_immutable();

alter table public.climate_file_reviews enable row level security;
create policy "Members can read climate reviews" on public.climate_file_reviews
  for select to authenticated using (public.is_org_member(organization_id));
revoke all on public.climate_file_reviews from anon, authenticated;
grant select on public.climate_file_reviews to authenticated;

-- The Edge Function reads a stored file's bytes to re-read it at review.
grant select on public.climate_import_files to service_role;

-- ---------------------------------------------------------------------------
-- Review actions
-- ---------------------------------------------------------------------------

-- 'activate': the file (a conflict, or one superseded earlier) is used for its
--   hour; the file in effect until now becomes superseded.
-- 'set_aside': a conflicting file stays stored but is not used (superseded).
create or replace function public.climate_review_file(p_file_id uuid, p_action text, p_note text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  f        public.climate_import_files;
  v_active public.climate_import_files;
  v_uid    uuid := auth.uid();
begin
  select * into f from public.climate_import_files where id = p_file_id;
  if f.id is null or not public.is_org_owner(f.organization_id) then
    raise exception 'Only an organization owner can review climate imports' using errcode = '42501';
  end if;
  if p_note is null or char_length(btrim(p_note)) = 0 then
    raise exception 'A note explaining the decision is required' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('climate_ingest:' || f.source_id::text, 0));
  select * into f from public.climate_import_files where id = p_file_id;

  if p_action = 'activate' then
    if f.hour_state not in ('conflict', 'superseded') then
      raise exception 'Only a conflicting or superseded file can be put into effect (this one is %)', f.hour_state using errcode = '22023';
    end if;
    select * into v_active from public.climate_import_files
     where source_id = f.source_id and hour_utc = f.hour_utc and hour_state = 'active';
    if v_active.id is not null then
      update public.climate_import_files set hour_state = 'superseded', reviewed_at = now(), reviewed_by = v_uid, review_note = left(btrim(p_note), 500)
       where id = v_active.id;
      insert into public.climate_file_reviews (organization_id, source_id, file_id, action, state_before, state_after, hour_utc, note, reviewed_by)
      values (f.organization_id, f.source_id, v_active.id, 'superseded_by_review', 'active', 'superseded', f.hour_utc, left(btrim(p_note), 500), v_uid);
    end if;
    update public.climate_import_files set hour_state = 'active', reviewed_at = now(), reviewed_by = v_uid, review_note = left(btrim(p_note), 500)
     where id = f.id;
    insert into public.climate_file_reviews (organization_id, source_id, file_id, action, state_before, state_after, replaced_file_id, hour_utc, note, reviewed_by)
    values (f.organization_id, f.source_id, f.id, 'activate', f.hour_state, 'active', v_active.id, f.hour_utc, left(btrim(p_note), 500), v_uid);
    return jsonb_build_object('file_id', f.id, 'state', 'active', 'replaced_file_id', v_active.id);
  elsif p_action = 'set_aside' then
    if f.hour_state <> 'conflict' then
      raise exception 'Only a conflicting file can be set aside (this one is %)', f.hour_state using errcode = '22023';
    end if;
    update public.climate_import_files set hour_state = 'superseded', reviewed_at = now(), reviewed_by = v_uid, review_note = left(btrim(p_note), 500)
     where id = f.id;
    insert into public.climate_file_reviews (organization_id, source_id, file_id, action, state_before, state_after, hour_utc, note, reviewed_by)
    values (f.organization_id, f.source_id, f.id, 'set_aside', 'conflict', 'superseded', f.hour_utc, left(btrim(p_note), 500), v_uid);
    return jsonb_build_object('file_id', f.id, 'state', 'superseded');
  end if;
  raise exception 'Unknown review action %', p_action using errcode = '22023';
end;
$$;

-- Server only (the Edge Function checks the user's session first): a
-- quarantined file, re-read from its own stored bytes with the hour a reviewer
-- assigned, gets its readings. The original parse (problems, warnings,
-- filename, raw System date/time) stays as recorded.
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

-- A zone's friendly name; null or blank clears it. The source label is unchanged.
create or replace function public.climate_set_zone_display_name(p_zone_id uuid, p_display_name text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid;
begin
  select organization_id into v_org from public.climate_zones where id = p_zone_id;
  if v_org is null or not public.is_org_owner(v_org) then
    raise exception 'Only an organization owner can rename climate zones' using errcode = '42501';
  end if;
  update public.climate_zones set display_name = nullif(btrim(p_display_name), '') where id = p_zone_id;
end;
$$;

-- Server only: is this user an owner of the organization? (The Edge Function
-- checks it before revealing anything about a file at review.)
create or replace function public.climate_user_is_owner(p_user_id uuid, p_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.organization_members
                  where organization_id = p_organization_id and user_id = p_user_id and role = 'owner');
$$;

-- ---------------------------------------------------------------------------
-- Monitoring reads (members; row level security applies)
-- ---------------------------------------------------------------------------

-- Hourly values of the accepted files: [{zone_id, metric, unit, points: [[epoch_s, value|null, excluded 0/1, flags]]}].
-- excluded = a quality flag means the value isn't used in summaries.
create or replace function public.climate_series(p_source_id uuid, p_zone_ids uuid[], p_metrics text[], p_from timestamptz, p_to timestamptz)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object('zone_id', s.zone_id, 'metric', s.metric, 'unit', s.unit, 'points', s.points)
                            order by s.zone_id, s.metric), '[]'::jsonb)
    from (
      select r.zone_id, r.metric, max(r.unit) as unit,
             jsonb_agg(jsonb_build_array(extract(epoch from r.hour_utc)::bigint, r.value,
                                         case when r.value is null or r.flags && array['ph_zero_sentinel', 'ec_zero_suspect', 'out_of_range', 'not_numeric', 'unexpected_unit'] then 1 else 0 end,
                                         r.flags)
                       order by r.hour_utc) as points
        from public.climate_readings_active r
       where r.source_id = p_source_id
         and r.zone_id = any (p_zone_ids)
         and r.metric = any (p_metrics)
         and r.hour_utc >= p_from and r.hour_utc < p_to
         and p_to - p_from <= interval '93 days'
       group by r.zone_id, r.metric
    ) s;
$$;

-- Daily summaries per zone and metric (greenhouse-local dates, usable values only):
-- [{zone_id, metric, days: [[date, hours_with_value, mean, min, max, excluded]]}].
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
           (r.value is null or r.flags && array['ph_zero_sentinel', 'ec_zero_suspect', 'out_of_range', 'not_numeric', 'unexpected_unit']) as excluded
      from public.climate_readings_active r
     where r.source_id = p_source_id
       and r.zone_id = any (p_zone_ids)
       and r.metric = any (p_metrics)
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

-- Hours in [p_from, p_to) without an accepted file: [[gap_start, gap_end_exclusive, hours]].
create or replace function public.climate_missing_hours(p_source_id uuid, p_from timestamptz, p_to timestamptz)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  with hours as (
    select h
      from generate_series(date_trunc('hour', p_from), p_to - interval '1 hour', interval '1 hour') h
     where p_to - p_from <= interval '400 days'
       and not exists (select 1 from public.climate_import_files f
                        where f.source_id = p_source_id and f.hour_utc = h and f.hour_state = 'active')
  ),
  grouped as (
    select h, h - (row_number() over (order by h)) * interval '1 hour' as g from hours
  )
  select coalesce(jsonb_agg(jsonb_build_array(s, e, n) order by s), '[]'::jsonb)
    from (select min(h) as s, max(h) + interval '1 hour' as e, count(*) as n from grouped group by g) x;
$$;

-- The source's import health at a glance.
create or replace function public.climate_import_status(p_source_id uuid)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select jsonb_build_object(
    'last_success', (
      select jsonb_build_object('received_at', a.created_at, 'filename', a.filename, 'channel', a.channel, 'hour_utc', f.hour_utc, 'hour_local', f.hour_local)
        from public.climate_import_attempts a join public.climate_import_files f on f.id = a.file_id
       where a.source_id = p_source_id and a.outcome = 'created'
       order by a.created_at desc, a.id desc limit 1),
    'latest_hour', (select max(hour_utc) from public.climate_import_files where source_id = p_source_id and hour_state = 'active'),
    'first_hour', (select min(hour_utc) from public.climate_import_files where source_id = p_source_id and hour_state = 'active'),
    'files', (select jsonb_object_agg(hour_state, n) from (select hour_state, count(*) n from public.climate_import_files where source_id = p_source_id group by hour_state) x),
    'attempts_7d', (select jsonb_object_agg(outcome, n) from (select outcome, count(*) n from public.climate_import_attempts
                                                               where source_id = p_source_id and created_at > now() - interval '7 days' group by outcome) x),
    'to_review', (select count(*) from public.climate_import_files where source_id = p_source_id and hour_state in ('conflict', 'none')),
    'missing_7d', (select count(*) from generate_series(date_trunc('hour', now()) - interval '7 days', date_trunc('hour', now()) - interval '1 hour', interval '1 hour') h
                    where h >= (select min(hour_utc) from public.climate_import_files where source_id = p_source_id and hour_state = 'active')
                      and not exists (select 1 from public.climate_import_files f where f.source_id = p_source_id and f.hour_utc = h and f.hour_state = 'active')),
    'agent_last_used', (select max(last_used_at) from public.climate_agent_keys where source_id = p_source_id)
  );
$$;

-- A planting's hourly values: only from zones it occupied on each reading's
-- local date (as recorded at p_as_of), with that zone's area share then.
-- [{zone_id, source_label, metric, unit, points: [[epoch_s, value|null, excluded, area_share|null]]}].
create or replace function public.crop_climate_series(p_crop_id uuid, p_metrics text[], p_from timestamptz, p_to timestamptz, p_as_of timestamptz default 'infinity')
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object('zone_id', s.zone_id, 'source_label', s.source_label, 'metric', s.metric, 'unit', s.unit, 'points', s.points)
                            order by s.source_label, s.metric), '[]'::jsonb)
    from (
      select c.zone_id, c.source_label, c.metric, max(c.unit) as unit,
             jsonb_agg(jsonb_build_array(extract(epoch from c.hour_utc)::bigint, c.value,
                                         case when c.value is null or c.flags && array['ph_zero_sentinel', 'ec_zero_suspect', 'out_of_range', 'not_numeric', 'unexpected_unit'] then 1 else 0 end,
                                         c.area_share)
                       order by c.hour_utc) as points
        from public.crop_climate_readings(p_crop_id, p_from, p_to, p_as_of) c
       where c.metric = any (p_metrics)
         and p_to - p_from <= interval '93 days'
       group by c.zone_id, c.source_label, c.metric
    ) s;
$$;

revoke execute on function public.climate_review_file(uuid, text, text),
  public.climate_set_zone_display_name(uuid, text),
  public.climate_series(uuid, uuid[], text[], timestamptz, timestamptz),
  public.climate_daily(uuid, uuid[], text[], date, date),
  public.climate_missing_hours(uuid, timestamptz, timestamptz),
  public.climate_import_status(uuid),
  public.crop_climate_series(uuid, text[], timestamptz, timestamptz, timestamptz)
  from public, anon;
grant execute on function public.climate_review_file(uuid, text, text),
  public.climate_set_zone_display_name(uuid, text),
  public.climate_series(uuid, uuid[], text[], timestamptz, timestamptz),
  public.climate_daily(uuid, uuid[], text[], date, date),
  public.climate_missing_hours(uuid, timestamptz, timestamptz),
  public.climate_import_status(uuid),
  public.crop_climate_series(uuid, text[], timestamptz, timestamptz, timestamptz)
  to authenticated;
revoke execute on function public.climate_resolve_quarantined_file(uuid, uuid, jsonb, text),
  public.climate_user_is_owner(uuid, uuid) from public, anon, authenticated;
grant execute on function public.climate_resolve_quarantined_file(uuid, uuid, jsonb, text),
  public.climate_user_is_owner(uuid, uuid) to service_role;
