-- Plants: mobile status options
--
-- Which statuses the mobile collector offers when a worker records a node's
-- status. One row per organization and status, like node_attention_rules:
--
--   enabled = true   offered in the collector's status picker
--   enabled = false  not offered for new entries
--
-- Hiding a status only limits NEW entries. It never touches observations:
-- recorded statuses keep their meaning and stay visible and counted everywhere
-- (Plants digital twin, Weekly Plant Data, cohorts, Fruit Loss, Picked kg).
--
-- Every organization starts with all seven statuses enabled, so this migration
-- changes no collector. A status with no row counts as enabled. At least one
-- status must stay enabled: checked when the transaction commits, so a save
-- can switch statuses on and off in any order.

create table public.mobile_status_options (
  organization_id  uuid not null references public.organizations (id) on delete cascade,
  status           text not null check (status in (
                     'Aborted', 'Pruned', 'Flower', 'SetFruit', 'MatureGreen', 'BreakerFruit', 'Harvested'
                   )),
  enabled          boolean not null default true,
  updated_by       uuid references auth.users (id) on delete set null default auth.uid(),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  primary key (organization_id, status)
);

-- Who changed an option last, and when.
create or replace function public.mobile_status_options_stamp()
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

create trigger mobile_status_options_stamp
  before update on public.mobile_status_options
  for each row execute function public.mobile_status_options_stamp();

-- All seven enabled for every organization, now and when one is created.
create or replace function public.seed_mobile_status_options()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.mobile_status_options (organization_id, status, enabled, updated_by)
  select new.id, s.status, true, null
  from unnest(array['Aborted', 'Pruned', 'Flower', 'SetFruit', 'MatureGreen', 'BreakerFruit', 'Harvested']) as s(status)
  on conflict do nothing;
  return new;
end;
$$;

create trigger organizations_seed_mobile_status_options
  after insert on public.organizations
  for each row execute function public.seed_mobile_status_options();

insert into public.mobile_status_options (organization_id, status, enabled, updated_by)
select o.id, s.status, true, null
from public.organizations o
cross join unnest(array['Aborted', 'Pruned', 'Flower', 'SetFruit', 'MatureGreen', 'BreakerFruit', 'Harvested']) as s(status)
on conflict do nothing;

-- Members read them (the collector needs them); owners change them. No deletes.
alter table public.mobile_status_options enable row level security;

create policy "Members can read mobile status options"
  on public.mobile_status_options for select to authenticated
  using (public.is_org_member(organization_id));
create policy "Owners can add mobile status options"
  on public.mobile_status_options for insert to authenticated
  with check (public.is_org_owner(organization_id));
create policy "Owners can change mobile status options"
  on public.mobile_status_options for update to authenticated
  using (public.is_org_owner(organization_id))
  with check (public.is_org_owner(organization_id));

revoke all on public.mobile_status_options from anon, authenticated;
grant select, insert, update on public.mobile_status_options to authenticated;

-- Never zero statuses: at commit, the organization must still offer at least
-- one (a status without a row counts as enabled). Created after the backfill,
-- so no check is pending when the table is altered above.
create or replace function public.mobile_status_options_keep_one()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (select count(*) from public.mobile_status_options o
      where o.organization_id = new.organization_id and not o.enabled) >= 7 then
    raise exception 'At least one mobile status must stay enabled.' using errcode = 'check_violation';
  end if;
  return null;
end;
$$;

create constraint trigger mobile_status_options_keep_one
  after insert or update on public.mobile_status_options
  deferrable initially deferred
  for each row execute function public.mobile_status_options_keep_one();

revoke execute on function public.seed_mobile_status_options() from public, anon, authenticated;
revoke execute on function public.mobile_status_options_stamp() from public, anon, authenticated;
revoke execute on function public.mobile_status_options_keep_one() from public, anon, authenticated;
