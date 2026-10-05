-- Plants: initial schema
--
-- Tenancy model
--   organizations         one greenhouse business
--   organization_members  which auth users belong to which organization
--   crops                 one specific planting of a variety (UI label: "Variety")
--
-- Every business table carries organization_id and is protected by RLS so a
-- user can only ever see rows belonging to organizations they are a member of.
-- The frontend uses only the anon/publishable key; all access is governed here.

-- ---------------------------------------------------------------------------
-- Shared helpers
-- ---------------------------------------------------------------------------

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Organizations
-- ---------------------------------------------------------------------------

create table public.organizations (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (char_length(btrim(name)) between 1 and 120),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create trigger organizations_set_updated_at
  before update on public.organizations
  for each row execute function public.set_updated_at();

create table public.organization_members (
  organization_id  uuid not null references public.organizations (id) on delete cascade,
  user_id          uuid not null references auth.users (id) on delete cascade,
  role             text not null default 'member' check (role in ('owner', 'member')),
  created_at       timestamptz not null default now(),
  primary key (organization_id, user_id)
);

create index organization_members_user_id_idx on public.organization_members (user_id);

-- Membership check used by RLS policies. SECURITY DEFINER so policies on
-- organization_members itself don't recurse.
create or replace function public.is_org_member(org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.organization_members m
    where m.organization_id = org_id
      and m.user_id = (select auth.uid())
  );
$$;

create or replace function public.is_org_owner(org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.organization_members m
    where m.organization_id = org_id
      and m.user_id = (select auth.uid())
      and m.role = 'owner'
  );
$$;

-- Creates an organization and makes the caller its owner, atomically.
-- This is the only way to create organizations/memberships from the client.
create or replace function public.create_organization(org_name text)
returns public.organizations
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := (select auth.uid());
  org public.organizations;
begin
  if uid is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;

  insert into public.organizations (name)
  values (btrim(org_name))
  returning * into org;

  insert into public.organization_members (organization_id, user_id, role)
  values (org.id, uid, 'owner');

  return org;
end;
$$;

-- ---------------------------------------------------------------------------
-- Crops
--
-- A crop is a specific planting (e.g. "Cadalora, planted 2025-12-08"), not a
-- variety name. The same variety planted again next season is a new row.
-- Future observations, projections and harvest data will reference crops.id.
--
-- Status (planned / active / finished) is derived from the dates in the app
-- rather than stored, so it can never drift out of date.
-- ---------------------------------------------------------------------------

create table public.crops (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations (id) on delete restrict,
  name             text not null check (char_length(btrim(name)) between 1 and 100),
  color            text not null check (color in ('red', 'orange', 'yellow', 'green', 'other')),
  planting_date    date not null,
  pullout_date     date not null,
  area_m2          numeric(12, 2) not null check (area_m2 > 0),
  picking_stems    integer not null check (picking_stems > 0),
  created_by       uuid references auth.users (id) on delete set null default auth.uid(),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint crops_pullout_after_planting check (pullout_date > planting_date)
);

create index crops_organization_planting_idx
  on public.crops (organization_id, planting_date desc);

create trigger crops_set_updated_at
  before update on public.crops
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------

alter table public.organizations        enable row level security;
alter table public.organization_members enable row level security;
alter table public.crops                enable row level security;

create policy "Members can read their organizations"
  on public.organizations for select
  to authenticated
  using (public.is_org_member(id));

create policy "Owners can update their organizations"
  on public.organizations for update
  to authenticated
  using (public.is_org_owner(id))
  with check (public.is_org_owner(id));

create policy "Members can read memberships of their organizations"
  on public.organization_members for select
  to authenticated
  using (public.is_org_member(organization_id));

create policy "Members can read crops"
  on public.crops for select
  to authenticated
  using (public.is_org_member(organization_id));

create policy "Members can create crops"
  on public.crops for insert
  to authenticated
  with check (public.is_org_member(organization_id));

create policy "Members can update crops"
  on public.crops for update
  to authenticated
  using (public.is_org_member(organization_id))
  with check (public.is_org_member(organization_id));

-- ---------------------------------------------------------------------------
-- Grants (explicit, so behaviour doesn't depend on project defaults)
-- ---------------------------------------------------------------------------

revoke all on public.organizations, public.organization_members, public.crops from anon;
grant select, update         on public.organizations        to authenticated;
grant select                 on public.organization_members to authenticated;
grant select, insert, update on public.crops                to authenticated;

revoke execute on function public.is_org_member(uuid)       from public, anon;
revoke execute on function public.is_org_owner(uuid)        from public, anon;
revoke execute on function public.create_organization(text) from public, anon;
grant  execute on function public.is_org_member(uuid)       to authenticated;
grant  execute on function public.is_org_owner(uuid)        to authenticated;
grant  execute on function public.create_organization(text) to authenticated;
