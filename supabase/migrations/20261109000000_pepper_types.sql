-- Plants: pepper types as separate forecasting model groups
--
-- Each variety (crop) belongs to one pepper type, e.g. Bell Pepper or Long
-- Pointed Pepper. Pepper types are rows, not hard-coded names, so more can be
-- added per organization. A type holds the model assumptions its varieties
-- fall back on before they have enough history of their own:
--
--   provisional_survival  share of set peppers harvested (0–1), or null
--   provisional_timing    share of the harvest at each age 0 … 10 weeks
--                         after set (adds up to 1), or null
--   default_afw_g         AFW for a variety with no AFW entered yet, or null
--   pool_within_type      let a variety without enough completed cohorts use
--                         the completed cohorts of other varieties of the
--                         SAME type (off by default)
--
-- Null means "not configured": the outlook says so instead of borrowing
-- another type's values. A variety can override the provisional survival
-- and timing (crops.sets_provisional_*).
--
-- Model isolation is enforced in the database: pepper_type_cohort_outcomes()
-- returns cohorts only from varieties of the requested type, and per-variety
-- functions (set_cohort_outcomes, weekly_new_sets) only ever read one
-- variety. Nothing reads across types.
--
-- Existing varieties are all bell peppers: every existing organization gets
-- both types, and every existing crop is set to its organization's Bell
-- Pepper. Bell's provisional values are the ones the Sets outlook used until
-- now (60%, harvest 5–8 weeks after set), so its outputs don't change. Long
-- Pointed Pepper starts with nothing configured. New organizations get both
-- types; new crops must name their type (no default).

create or replace function public.valid_timing_shares(p_shares numeric[])
returns boolean
language sql
immutable
set search_path = ''
as $$
  select array_length(p_shares, 1) = 11
     and array_position(p_shares, null) is null
     and (select bool_and(s >= 0) and abs(sum(s) - 1) <= 0.001 from unnest(p_shares) s)
$$;

create table public.pepper_types (
  id                    uuid primary key default gen_random_uuid(),
  organization_id       uuid not null references public.organizations (id) on delete restrict,
  key                   text not null check (key ~ '^[a-z][a-z0-9_]{1,40}$'),
  name                  text not null check (char_length(btrim(name)) between 1 and 60),
  provisional_survival  numeric(4, 3) check (provisional_survival > 0 and provisional_survival <= 1),
  provisional_timing    numeric(5, 4)[] check (provisional_timing is null or public.valid_timing_shares(provisional_timing)),
  default_afw_g         numeric(6, 1) check (default_afw_g > 0 and default_afw_g <= 2000),
  pool_within_type      boolean not null default false,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint pepper_types_key unique (organization_id, key),
  constraint pepper_types_name unique (organization_id, name),
  constraint pepper_types_organization_id_id_key unique (organization_id, id)
);

comment on table public.pepper_types is
  'Forecasting model groups: varieties learn and fall back only within their own pepper type.';

create trigger pepper_types_set_updated_at
  before update on public.pepper_types
  for each row execute function public.set_updated_at();

alter table public.pepper_types enable row level security;

create policy "Members can read pepper types"
  on public.pepper_types for select to authenticated
  using (public.is_org_member(organization_id));
create policy "Owners can add pepper types"
  on public.pepper_types for insert to authenticated
  with check (public.is_org_owner(organization_id));
create policy "Owners can change pepper types"
  on public.pepper_types for update to authenticated
  using (public.is_org_owner(organization_id))
  with check (public.is_org_owner(organization_id));

revoke all on public.pepper_types from anon, authenticated;
grant select, insert, update on public.pepper_types to authenticated;

-- The two initial types for an organization.
create or replace function public.seed_pepper_types(p_organization_id uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.pepper_types (organization_id, key, name, provisional_survival, provisional_timing)
  values
    (p_organization_id, 'bell', 'Bell Pepper', 0.6, '{0, 0, 0, 0, 0, 0.2, 0.3, 0.3, 0.2, 0, 0}'),
    (p_organization_id, 'long_pointed', 'Long Pointed Pepper', null, null)
  on conflict on constraint pepper_types_key do nothing;
$$;

revoke execute on function public.seed_pepper_types(uuid) from public, anon, authenticated;

create or replace function public.organizations_seed_pepper_types()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.seed_pepper_types(new.id);
  return new;
end;
$$;

revoke execute on function public.organizations_seed_pepper_types() from public, anon, authenticated;

create trigger organizations_seed_pepper_types
  after insert on public.organizations
  for each row execute function public.organizations_seed_pepper_types();

select public.seed_pepper_types(o.id) from public.organizations o;

-- Every crop belongs to a pepper type of its own organization.
alter table public.crops add column pepper_type_id uuid;

-- Classification only: the crop's own settings and updated_at stay as they were.
alter table public.crops disable trigger crops_set_updated_at;
update public.crops c
   set pepper_type_id = t.id
  from public.pepper_types t
 where t.organization_id = c.organization_id and t.key = 'bell';
alter table public.crops enable trigger crops_set_updated_at;

alter table public.crops
  alter column pepper_type_id set not null,
  add constraint crops_pepper_type_fkey
    foreign key (organization_id, pepper_type_id)
    references public.pepper_types (organization_id, id) on delete restrict;

create index crops_pepper_type_idx on public.crops (pepper_type_id);

-- Variety-level overrides of the type's provisional assumptions (null: the type's).
alter table public.crops
  add column sets_provisional_survival numeric(4, 3)
    check (sets_provisional_survival > 0 and sets_provisional_survival <= 1),
  add column sets_provisional_timing numeric(5, 4)[]
    check (sets_provisional_timing is null or public.valid_timing_shares(sets_provisional_timing));

comment on column public.crops.pepper_type_id is 'The forecasting model group: this variety learns and falls back only within it.';

-- Cohort outcomes of every variety of ONE pepper type (for within-type
-- fallback). Varieties of other types are never read.
create or replace function public.pepper_type_cohort_outcomes(
  p_pepper_type_id uuid,
  p_year integer
)
returns table (
  crop_id uuid,
  pepper_type_id uuid,
  set_year integer,
  set_week integer,
  is_baseline boolean,
  sets integer,
  harvested_by_age integer[],
  aborted_by_age integer[],
  pruned_by_age integer[],
  resolved_later integer,
  on_plant integer
)
language sql
stable
security invoker
set search_path = ''
as $$
  select c.id, c.pepper_type_id, o.set_year, o.set_week, o.is_baseline, o.sets,
         o.harvested_by_age, o.aborted_by_age, o.pruned_by_age, o.resolved_later, o.on_plant
    from public.crops c
   cross join lateral public.set_cohort_outcomes(c.id, p_year) o
   where c.pepper_type_id = p_pepper_type_id
   order by c.id, o.set_year, o.set_week;
$$;

revoke execute on function public.pepper_type_cohort_outcomes(uuid, integer) from public, anon;
grant execute on function public.pepper_type_cohort_outcomes(uuid, integer) to authenticated;
