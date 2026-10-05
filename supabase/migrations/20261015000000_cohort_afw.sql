-- Plants: manual average fruit weight (AFW) per set-week cohort
--
-- Entered by hand on Projections › Weekly Plant Data, in grams per fruit, for
-- each set week of a crop, including open and future cohorts (expected AFW
-- for projections). Used to turn a cohort's harvested share into kg:
--
--   picked kg = cohort Sets/m² × Σ observed harvest % of that cohort
--               × AFW g ÷ 1000 × crop area m²
--
-- Manual values are authoritative: nothing else writes this table. It changes
-- none of the cohort calculations (weekly_plant_data, set_harvest_cohorts).
-- set_year/set_week are the ISO year and week the cohort was set.

create table public.cohort_afw (
  organization_id  uuid not null,
  crop_id          uuid not null,
  set_year         integer not null check (set_year between 2000 and 2100),
  set_week         integer not null,
  afw_g            numeric(6, 1) not null check (afw_g > 0 and afw_g <= 2000),
  updated_by       uuid references auth.users (id) on delete set null default auth.uid(),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  primary key (crop_id, set_year, set_week),
  constraint cohort_afw_crop_fkey
    foreign key (organization_id, crop_id)
    references public.crops (organization_id, id) on delete cascade,
  constraint cohort_afw_iso_week_check
    check (set_week between 1 and public.iso_weeks_in_year(set_year))
);

-- Who changed a value last, and when.
create or replace function public.cohort_afw_stamp()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  new.updated_by := coalesce((select auth.uid()), new.updated_by);
  return new;
end;
$$;

create trigger cohort_afw_stamp
  before update on public.cohort_afw
  for each row execute function public.cohort_afw_stamp();

alter table public.cohort_afw enable row level security;

create policy "Members can read AFW"
  on public.cohort_afw for select to authenticated
  using (public.is_org_member(organization_id));
create policy "Members can add AFW"
  on public.cohort_afw for insert to authenticated
  with check (public.is_org_member(organization_id));
create policy "Members can change AFW"
  on public.cohort_afw for update to authenticated
  using (public.is_org_member(organization_id))
  with check (public.is_org_member(organization_id));
-- Clearing a week's AFW removes its row.
create policy "Members can clear AFW"
  on public.cohort_afw for delete to authenticated
  using (public.is_org_member(organization_id));

revoke all on public.cohort_afw from anon, authenticated;
grant select, insert, update, delete on public.cohort_afw to authenticated;

revoke execute on function public.cohort_afw_stamp() from public, anon, authenticated;
