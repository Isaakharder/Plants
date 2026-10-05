-- Plants: mobile attention rules
--
-- How long a node may keep its latest status before the mobile collector shows
-- the "needs an update" clock on it. One row per organization and status:
--
--   Flower 7 days · SetFruit 14 · MatureGreen 49 · BreakerFruit 14
--
-- A status with no row has no clock (Harvested, Aborted and Pruned are final:
-- nothing is left on the plant to update). Further statuses can get a rule
-- later by adding rows; nothing else changes. Organization-level only, no
-- per-variety overrides yet.
--
-- Separate from the Plants digital twin's "possibly stale" analysis, which
-- does not read this table.

create table public.node_attention_rules (
  organization_id  uuid not null references public.organizations (id) on delete cascade,
  status           text not null check (status in (
                     'Aborted', 'Pruned', 'Flower', 'SetFruit', 'MatureGreen', 'BreakerFruit', 'Harvested'
                   )),
  max_days         integer not null check (max_days between 1 and 365),
  updated_by       uuid references auth.users (id) on delete set null default auth.uid(),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  primary key (organization_id, status)
);

-- Who changed a rule last, and when.
create or replace function public.node_attention_rules_stamp()
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

create trigger node_attention_rules_stamp
  before update on public.node_attention_rules
  for each row execute function public.node_attention_rules_stamp();

-- Defaults for every organization, now and when one is created.
create or replace function public.seed_node_attention_rules()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.node_attention_rules (organization_id, status, max_days, updated_by)
  values (new.id, 'Flower', 7, null), (new.id, 'SetFruit', 14, null), (new.id, 'MatureGreen', 49, null), (new.id, 'BreakerFruit', 14, null)
  on conflict do nothing;
  return new;
end;
$$;

create trigger organizations_seed_node_attention_rules
  after insert on public.organizations
  for each row execute function public.seed_node_attention_rules();

insert into public.node_attention_rules (organization_id, status, max_days, updated_by)
select o.id, r.status, r.max_days, null
from public.organizations o
cross join (values ('Flower', 7), ('SetFruit', 14), ('MatureGreen', 49), ('BreakerFruit', 14)) r(status, max_days)
on conflict do nothing;

-- Members read them (the collector needs them); owners change them. No deletes.
alter table public.node_attention_rules enable row level security;

create policy "Members can read attention rules"
  on public.node_attention_rules for select to authenticated
  using (public.is_org_member(organization_id));
create policy "Owners can add attention rules"
  on public.node_attention_rules for insert to authenticated
  with check (public.is_org_owner(organization_id));
create policy "Owners can change attention rules"
  on public.node_attention_rules for update to authenticated
  using (public.is_org_owner(organization_id))
  with check (public.is_org_owner(organization_id));

revoke all on public.node_attention_rules from anon, authenticated;
grant select, insert, update on public.node_attention_rules to authenticated;

revoke execute on function public.seed_node_attention_rules() from public, anon, authenticated;
revoke execute on function public.node_attention_rules_stamp() from public, anon, authenticated;
