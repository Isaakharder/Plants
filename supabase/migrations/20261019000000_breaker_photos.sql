-- Plants: Breaker photographs
--
-- Additive only: three new tables, one private Storage bucket and its
-- policies. No existing table, function or record changes; the forecast
-- calculations are untouched. Manual Breaker recording without photos keeps
-- working exactly as before.
--
--   node_photos             append-only: one row per photograph (front or
--                           back) of a BreakerFruit observation, with where
--                           the node was when it was taken
--   photo_colour_analyses   append-only: a colour-coverage estimate of a
--                           photo pair (manual now; automatic later). A
--                           correction is a new row superseding another.
--   photo_pair_corrections  append-only: a person reassigning a photo pair to
--                           the node that is really in the picture, or
--                           marking it unusable. Photos, observations and
--                           stages are never changed or deleted by this.
--
-- Association with the physical pepper:
--   * A photo references the exact observation record it documents
--     (node_observations.id, created by the same Breaker save on the phone).
--   * A trigger checks the observation is a BreakerFruit record of the same
--     node, crop and organization, and copies the node's position at that
--     moment (row, stem, node number / label, side shoot) and the crop's
--     target colour. Later node renumbering can't move a photo.
--   * The photo pair's effective node is the latest reassignment, if any;
--     otherwise the observation's node.
--
-- Storage: bucket 'node-photos', private, 25 MB per object, images only.
-- Paths: <organization>/<crop>/<node>/<photo id>.<ext> for the original and
-- <organization>/<crop>/<node>/<photo id>.preview.jpg for the preview made on
-- the phone. Members of the organization (first path segment) may read and
-- add objects; no one can overwrite or delete them through the API.
--
-- Rollback: supabase/rollback/20261019000000_breaker_photos_down.sql.

-- ---------------------------------------------------------------------------
-- node_photos
-- ---------------------------------------------------------------------------

create table public.node_photos (
  id                   uuid primary key,
  organization_id      uuid not null,
  crop_id              uuid not null,
  plant_node_id        uuid not null,
  node_observation_id  uuid not null references public.node_observations (id),
  side                 text not null check (side in ('front', 'back')),
  -- Where the node was, and the crop's ripe colour, at capture (set by the trigger; never change).
  measurement_stem_id  uuid not null,
  measurement_row_id   uuid not null,
  node_number          integer not null,
  node_label           text,
  is_side_shoot        boolean not null,
  target_colour        text not null,
  -- Greenhouse ISO week of the observation.
  year                 integer not null,
  week_number          integer not null,
  storage_path         text not null unique check (char_length(storage_path) between 1 and 400),
  preview_path         text unique check (char_length(preview_path) between 1 and 400),
  content_type         text not null check (content_type in ('image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif')),
  bytes                integer not null check (bytes > 0 and bytes <= 25000000),
  width                integer check (width > 0),
  height               integer check (height > 0),
  -- SHA-256 of the original image bytes (hex).
  sha256               text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  -- When the photo was taken (device clock) and stored (server clock).
  taken_at             timestamptz not null,
  recorded_at          timestamptz not null default now(),
  -- How it was captured (app build, browser, original file name / time), for audits.
  capture_meta         jsonb not null default '{}'::jsonb check (pg_column_size(capture_meta) <= 4000),
  created_by           uuid references auth.users (id) on delete set null default auth.uid(),
  constraint node_photos_node_fkey
    foreign key (organization_id, crop_id, plant_node_id)
    references public.plant_nodes (organization_id, crop_id, id) on delete restrict,
  constraint node_photos_path_check
    check (storage_path like organization_id::text || '/' || crop_id::text || '/' || plant_node_id::text || '/' || id::text || '.%'),
  constraint node_photos_preview_folder_check
    check (preview_path is null
           or preview_path = organization_id::text || '/' || crop_id::text || '/' || plant_node_id::text || '/' || id::text || '.preview.jpg')
);

create index node_photos_observation_idx on public.node_photos (node_observation_id, side, taken_at);
create index node_photos_crop_week_idx on public.node_photos (crop_id, year, week_number);

comment on table public.node_photos is
  'Append-only: Breaker photographs (front / back) of a node observation, with where the node was at capture. Images live in the private node-photos bucket.';

create or replace function public.node_photos_bind()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_obs public.node_observations;
  v_node public.plant_nodes;
  v_stem public.measurement_stems;
begin
  select * into v_obs from public.node_observations where id = new.node_observation_id;
  if v_obs.id is null or v_obs.plant_node_id <> new.plant_node_id or v_obs.crop_id <> new.crop_id or v_obs.organization_id <> new.organization_id then
    raise exception 'The photo''s observation belongs to another node' using errcode = '23514';
  end if;
  if v_obs.status <> 'BreakerFruit' then
    raise exception 'Photos document BreakerFruit records only' using errcode = '23514';
  end if;
  select * into v_node from public.plant_nodes where id = new.plant_node_id;
  select * into v_stem from public.measurement_stems where id = v_node.measurement_stem_id;
  new.measurement_stem_id := v_node.measurement_stem_id;
  new.measurement_row_id := v_stem.measurement_row_id;
  new.node_number := v_node.node_number;
  new.node_label := v_node.node_label;
  new.is_side_shoot := v_node.is_side_shoot;
  new.target_colour := (select c.color from public.crops c where c.id = new.crop_id);
  new.year := v_obs.year;
  new.week_number := v_obs.week_number;
  return new;
end;
$$;

create trigger node_photos_bind
  before insert on public.node_photos
  for each row execute function public.node_photos_bind();

revoke execute on function public.node_photos_bind() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- photo_colour_analyses
-- ---------------------------------------------------------------------------

create table public.photo_colour_analyses (
  id                   uuid primary key default gen_random_uuid(),
  organization_id      uuid not null,
  crop_id              uuid not null,
  node_observation_id  uuid not null references public.node_observations (id),
  front_photo_id       uuid references public.node_photos (id),
  back_photo_id        uuid references public.node_photos (id),
  -- 'manual' (a person's estimate), 'correction' (a person correcting another row), 'automatic' (a future analysis method).
  kind                 text not null check (kind in ('automatic', 'manual', 'correction')),
  method               text not null check (char_length(method) between 1 and 60),
  model_version        text not null check (char_length(model_version) between 1 and 60),
  target_colour        text not null check (target_colour in ('red', 'orange', 'yellow', 'green', 'other')),
  front_percent        numeric(5, 2) check (front_percent between 0 and 100),
  back_percent         numeric(5, 2) check (back_percent between 0 and 100),
  combined_percent     numeric(5, 2) not null check (combined_percent between 0 and 100),
  confidence           numeric(4, 3) check (confidence between 0 and 1),
  details              jsonb not null default '{}'::jsonb,
  supersedes_id        uuid references public.photo_colour_analyses (id),
  note                 text check (char_length(note) <= 1000),
  created_at           timestamptz not null default now(),
  created_by           uuid references auth.users (id) on delete set null default auth.uid(),
  constraint photo_colour_analyses_crop_fkey
    foreign key (organization_id, crop_id)
    references public.crops (organization_id, id) on delete restrict,
  constraint photo_colour_analyses_correction_check
    check ((kind = 'correction') = (supersedes_id is not null))
);

create index photo_colour_analyses_observation_idx on public.photo_colour_analyses (node_observation_id, created_at desc);

comment on table public.photo_colour_analyses is
  'Append-only colour-coverage estimates of a Breaker photo pair. Corrections are new rows that supersede an earlier one; nothing is overwritten.';

-- ---------------------------------------------------------------------------
-- photo_pair_corrections
-- ---------------------------------------------------------------------------

create table public.photo_pair_corrections (
  id                   uuid primary key default gen_random_uuid(),
  organization_id      uuid not null,
  crop_id              uuid not null,
  node_observation_id  uuid not null references public.node_observations (id),
  -- 'reassign_node': the pepper in the photos is on corrected_node_id.
  -- 'unusable': the photos can't be used (blurred, wrong fruit, …).
  -- 'restore': undo the latest correction (the pair is as captured again).
  kind                 text not null check (kind in ('reassign_node', 'unusable', 'restore')),
  corrected_node_id    uuid,
  note                 text check (char_length(note) <= 1000),
  created_at           timestamptz not null default now(),
  created_by           uuid references auth.users (id) on delete set null default auth.uid(),
  constraint photo_pair_corrections_node_fkey
    foreign key (organization_id, crop_id, corrected_node_id)
    references public.plant_nodes (organization_id, crop_id, id) on delete restrict,
  constraint photo_pair_corrections_shape
    check ((kind = 'reassign_node') = (corrected_node_id is not null))
);

create index photo_pair_corrections_observation_idx on public.photo_pair_corrections (node_observation_id, created_at desc);

comment on table public.photo_pair_corrections is
  'Append-only: reassigning a Breaker photo pair to the node really photographed, or marking it unusable. The latest row per observation is in effect.';

-- The observation must have photos, in the same crop and organization.
create or replace function public.photo_pair_corrections_check()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.node_photos p
    where p.node_observation_id = new.node_observation_id and p.crop_id = new.crop_id and p.organization_id = new.organization_id
  ) then
    raise exception 'No photos of that observation in this crop' using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger photo_pair_corrections_check
  before insert on public.photo_pair_corrections
  for each row execute function public.photo_pair_corrections_check();

revoke execute on function public.photo_pair_corrections_check() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Row level security and grants: read and append only
-- ---------------------------------------------------------------------------

alter table public.node_photos enable row level security;
alter table public.photo_colour_analyses enable row level security;
alter table public.photo_pair_corrections enable row level security;

create policy "Members can read photos"
  on public.node_photos for select to authenticated
  using (public.is_org_member(organization_id));
create policy "Members can add photos"
  on public.node_photos for insert to authenticated
  with check (public.is_org_member(organization_id));
create policy "Members can read colour analyses"
  on public.photo_colour_analyses for select to authenticated
  using (public.is_org_member(organization_id));
create policy "Members can add manual colour analyses"
  on public.photo_colour_analyses for insert to authenticated
  with check (public.is_org_member(organization_id) and kind in ('manual', 'correction'));
create policy "Members can read photo corrections"
  on public.photo_pair_corrections for select to authenticated
  using (public.is_org_member(organization_id));
create policy "Members can correct photo pairs"
  on public.photo_pair_corrections for insert to authenticated
  with check (public.is_org_member(organization_id));

revoke all on public.node_photos, public.photo_colour_analyses, public.photo_pair_corrections from anon, authenticated;
grant select, insert on public.node_photos, public.photo_colour_analyses, public.photo_pair_corrections to authenticated;

-- ---------------------------------------------------------------------------
-- Private Storage bucket (Supabase Storage; skipped where it isn't installed)
-- ---------------------------------------------------------------------------

-- True when the caller is a member of the organization named by an object
-- path's first folder; false for any path whose first folder isn't an id
-- (never an error).
create or replace function public.is_member_of_path_org(p_name text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_first text := split_part(p_name, '/', 1);
begin
  if v_first !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return false;
  end if;
  return public.is_org_member(v_first::uuid);
end;
$$;

revoke execute on function public.is_member_of_path_org(text) from public, anon;
grant  execute on function public.is_member_of_path_org(text) to authenticated;

do $outer$
begin
  if not exists (select 1 from pg_namespace where nspname = 'storage') then
    raise notice 'Supabase Storage not installed: skipping the node-photos bucket';
    return;
  end if;

  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('node-photos', 'node-photos', false, 25000000, array['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'])
  on conflict (id) do nothing;

  execute $p$
    create policy "node-photos: members read their organization's photos"
      on storage.objects for select to authenticated
      using (bucket_id = 'node-photos' and public.is_member_of_path_org(name))
  $p$;
  execute $p$
    create policy "node-photos: members add their organization's photos"
      on storage.objects for insert to authenticated
      with check (bucket_id = 'node-photos' and public.is_member_of_path_org(name))
  $p$;
  -- No update or delete policy: stored photos can't be overwritten or removed through the API.
end
$outer$;
