-- Climate › Reports thresholds, shared by the whole organization
--
-- Approved 2026-10-21. One set of thresholds per organization, used by the
-- Yesterday and Last 7 Days reports for every variety:
--   high_temp     °C, hourly readings at or above count        (default 28)
--   high_rh       %, hourly readings above count                (default 88)
--   low_day_rh    %, daytime hourly readings below count        (default 70)
--   low_temp      °C, hourly readings below count               (unset)
--   low_day_co2   ppm, daytime hourly readings below count      (unset)
-- Only owners change them. Every change is a new row (append-only); the
-- latest row is in effect and earlier ones are the audit history. Until an
-- owner saves a change the defaults apply (climate_report_thresholds_in_effect):
-- this migration writes no data.

create table public.climate_report_thresholds (
  id               bigint generated always as identity primary key,
  organization_id  uuid not null references public.organizations (id) on delete cascade,
  high_temp        numeric(4, 1) not null check (high_temp between 0 and 50),
  high_rh          numeric(4, 1) not null check (high_rh between 0 and 100),
  low_day_rh       numeric(4, 1) not null check (low_day_rh between 0 and 100),
  low_temp         numeric(4, 1) check (low_temp between -10 and 40),
  low_day_co2      integer check (low_day_co2 between 0 and 3000),
  note             text check (char_length(note) <= 500),
  recorded_at      timestamptz not null default now(),
  recorded_by      uuid not null default auth.uid(),
  constraint climate_report_thresholds_rh_order check (low_day_rh < high_rh),
  constraint climate_report_thresholds_temp_order check (low_temp is null or low_temp < high_temp)
);

create index climate_report_thresholds_org_idx on public.climate_report_thresholds (organization_id, recorded_at desc, id desc);

comment on table public.climate_report_thresholds is
  'Append-only: climate report thresholds per organization. The latest row is in effect; earlier rows are the history of changes (who, when, why).';

create trigger climate_report_thresholds_immutable before update or delete on public.climate_report_thresholds
  for each row execute function public.climate_history_immutable();

alter table public.climate_report_thresholds enable row level security;

create policy "Members can read climate report thresholds" on public.climate_report_thresholds
  for select to authenticated using (public.is_org_member(organization_id));
-- Owners add a change in their own name; the time is the server's.
create policy "Owners can change climate report thresholds" on public.climate_report_thresholds
  for insert to authenticated with check (public.is_org_owner(organization_id) and recorded_by = (select auth.uid()));

revoke all on public.climate_report_thresholds from anon, authenticated;
grant select on public.climate_report_thresholds to authenticated;
grant insert (organization_id, high_temp, high_rh, low_day_rh, low_temp, low_day_co2, note) on public.climate_report_thresholds to authenticated;

-- The thresholds in effect: the latest change, or the defaults when there is none
-- (source 'default'). Read with the caller's RLS.
create or replace function public.climate_report_thresholds_in_effect(p_organization_id uuid)
returns table (
  high_temp    numeric,
  high_rh      numeric,
  low_day_rh   numeric,
  low_temp     numeric,
  low_day_co2  integer,
  source       text,          -- 'saved' | 'default'
  recorded_at  timestamptz,
  recorded_by  uuid,
  note         text
)
language sql
stable
security invoker
set search_path = ''
as $$
  with latest as (
    select t.high_temp, t.high_rh, t.low_day_rh, t.low_temp, t.low_day_co2, 'saved'::text as source, t.recorded_at, t.recorded_by, t.note
      from public.climate_report_thresholds t
     where t.organization_id = p_organization_id
     order by t.recorded_at desc, t.id desc
     limit 1
  )
  select * from latest
  union all
  select 28.0, 88.0, 70.0, null::numeric, null::integer, 'default', null::timestamptz, null::uuid, null::text
   where not exists (select 1 from latest)
$$;

revoke execute on function public.climate_report_thresholds_in_effect(uuid) from public, anon;
grant execute on function public.climate_report_thresholds_in_effect(uuid) to authenticated;
