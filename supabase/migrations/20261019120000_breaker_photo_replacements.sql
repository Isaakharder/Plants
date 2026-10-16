-- Breaker photos: replacing the photos of a recorded Breaker, and marking an
-- accidental second Breaker record of the same pepper as a duplicate.
--
-- A replacement is a new photo of the same Breaker record and side that names
-- the photo it replaces; the earlier photo stays stored and listed. A
-- duplicate is a correction row pointing at the Breaker record that is kept.
-- Neither changes or removes an existing photo, observation or correction.

-- ---------------------------------------------------------------------------
-- node_photos.replaces_photo_id
-- ---------------------------------------------------------------------------

alter table public.node_photos
  add column replaces_photo_id uuid references public.node_photos (id) on delete restrict;

create index node_photos_replaces_idx on public.node_photos (replaces_photo_id) where replaces_photo_id is not null;

comment on column public.node_photos.replaces_photo_id is
  'Set on a replacement photo: the earlier photo of the same Breaker record and side that it replaces. The earlier photo is kept.';

-- A replacement replaces a photo of the same Breaker record and side.
create or replace function public.node_photos_replacement_check()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old public.node_photos;
begin
  if new.replaces_photo_id is null then
    return new;
  end if;
  select * into v_old from public.node_photos where id = new.replaces_photo_id;
  if v_old.id is null or v_old.node_observation_id <> new.node_observation_id or v_old.side <> new.side then
    raise exception 'A replacement must replace a photo of the same Breaker record and side' using errcode = '23514';
  end if;
  return new;
end;
$$;

-- Runs after node_photos_bind (triggers fire in name order).
create trigger node_photos_replacement_check
  before insert on public.node_photos
  for each row execute function public.node_photos_replacement_check();

revoke execute on function public.node_photos_replacement_check() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- photo_pair_corrections: 'duplicate'
-- ---------------------------------------------------------------------------

alter table public.photo_pair_corrections
  drop constraint photo_pair_corrections_kind_check,
  add column duplicate_of_observation_id uuid references public.node_observations (id),
  add constraint photo_pair_corrections_kind_check
    check (kind in ('reassign_node', 'unusable', 'duplicate', 'restore')),
  add constraint photo_pair_corrections_duplicate_shape
    check ((kind = 'duplicate') = (duplicate_of_observation_id is not null));

comment on column public.photo_pair_corrections.duplicate_of_observation_id is
  'Set when kind = ''duplicate'': the Breaker record of the same node and week that is kept. Both records and their photos stay stored.';

comment on table public.photo_pair_corrections is
  'Append-only: reassigning a Breaker photo pair to the node really photographed, marking it unusable or a duplicate of another Breaker record of the same pepper, or restoring it. The latest row per observation is in effect.';

-- A duplicate points at another BreakerFruit record of the same node and week,
-- one that is not itself marked a duplicate.
create or replace function public.photo_pair_corrections_duplicate_check()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_this public.node_observations;
  v_kept public.node_observations;
begin
  if new.kind <> 'duplicate' then
    return new;
  end if;
  select * into v_this from public.node_observations where id = new.node_observation_id;
  select * into v_kept from public.node_observations where id = new.duplicate_of_observation_id;
  if v_kept.id is null or v_kept.id = v_this.id or v_kept.status <> 'BreakerFruit'
     or v_kept.plant_node_id <> v_this.plant_node_id or v_kept.organization_id <> v_this.organization_id
     or v_kept.year <> v_this.year or v_kept.week_number <> v_this.week_number then
    raise exception 'A duplicate must point at another Breaker record of the same node and week' using errcode = '23514';
  end if;
  -- The record kept must itself be in use (never two records marked duplicates of each other).
  if (select c.kind from public.photo_pair_corrections c where c.node_observation_id = v_kept.id order by c.created_at desc, c.id desc limit 1) = 'duplicate' then
    raise exception 'The record to keep is itself marked a duplicate' using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger photo_pair_corrections_duplicate_check
  before insert on public.photo_pair_corrections
  for each row execute function public.photo_pair_corrections_duplicate_check();

revoke execute on function public.photo_pair_corrections_duplicate_check() from public, anon, authenticated;
