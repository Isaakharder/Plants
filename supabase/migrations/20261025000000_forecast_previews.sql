-- Plants: saved preliminary forecasts (Harvest Forecast › Generate forecast).
--
-- Until now a generated forecast lived only in the open page and vanished on
-- navigation or refresh. Each generated forecast is now stored here, per
-- variety and sampling week, with a signature of the data it was computed
-- from, so the page can show it again later and say when it may be outdated.
--
-- Separate from forecast_runs on purpose: preliminary forecasts are never
-- official, never locked, never scored and never counted toward validation.
-- Append-only (a regeneration is a new row; the newest per week is shown).
-- Additive only: no existing table or row is changed.

create table public.forecast_previews (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null,
  crop_id           uuid not null,
  origin_year       integer not null,
  origin_week       integer not null,
  basis             text not null check (basis in ('lifecycle', 'breaker_only')),
  engine_version    text not null check (char_length(engine_version) between 1 and 40),
  -- forecast_input_signature() when it was computed: a different current value means the data changed since.
  input_signature   text not null check (char_length(input_signature) between 1 and 64),
  -- The computed preview, as the app shows it (forecast weeks, breakdown, reasons, cutoffs).
  preview           jsonb not null check (pg_column_size(preview) < 2000000),
  created_at        timestamptz not null default now(),
  created_by        uuid default auth.uid(),
  constraint forecast_previews_crop_fkey
    foreign key (organization_id, crop_id)
    references public.crops (organization_id, id) on delete restrict,
  constraint forecast_previews_week_check
    check (origin_week between 1 and public.iso_weeks_in_year(origin_year))
);

create index forecast_previews_crop_week_idx on public.forecast_previews (crop_id, origin_year, origin_week, created_at desc);

comment on table public.forecast_previews is
  'Append-only: preliminary forecasts generated in the app, per variety and sampling week (newest shown). Never official, never scored; official forecasts are forecast_runs.';

create trigger forecast_previews_stamp before insert on public.forecast_previews
  for each row execute function public.stamp_entry();
create trigger forecast_previews_immutable before update or delete on public.forecast_previews
  for each row execute function public.forecast_runs_immutable();

alter table public.forecast_previews enable row level security;
create policy "Members can read preliminary forecasts"
  on public.forecast_previews for select to authenticated
  using (public.is_org_member(organization_id));
create policy "Members can save preliminary forecasts"
  on public.forecast_previews for insert to authenticated
  with check (public.is_org_member(organization_id));
revoke all on public.forecast_previews from anon, authenticated;
grant select, insert on public.forecast_previews to authenticated;
grant select on public.forecast_previews to service_role;

-- A signature of everything a forecast from (year, week) reads: records,
-- stem checks and completions up to that week, nodes and stems as they stand,
-- AFW (any week: later weeks' AFW gives their kg), forecast settings, the
-- variety's own settings and data-quality reviews. Anything recorded,
-- corrected or reviewed since gives a different signature. Read with the
-- caller's rights (RLS applies).
create or replace function public.forecast_input_signature(p_crop_id uuid, p_year integer, p_week integer)
returns text
language sql
stable
security invoker
set search_path = ''
as $$
  with w as (
    select p_year * 100 + p_week as yw,
           ((to_date(p_year || '-' || lpad(p_week::text, 2, '0'), 'IYYY-IW') + 7)::timestamp at time zone 'America/Toronto') as week_end
  )
  select md5(concat_ws('|',
    (select count(*) || ':' || coalesce(max(o.recorded_at)::text, '-') from public.node_observations o, w
      where o.crop_id = p_crop_id and o.year * 100 + o.week_number <= w.yw),
    (select count(*) || ':' || coalesce(max(v.recorded_at)::text, '-') from public.stem_visits v, w
      where v.crop_id = p_crop_id and v.year * 100 + v.week_number <= w.yw),
    (select count(*) || ':' || coalesce(max(e.recorded_at)::text, '-') from public.sampling_week_events e, w
      where e.crop_id = p_crop_id and e.year * 100 + e.week_number <= w.yw),
    (select count(*) || ':' || coalesce(max(g.created_at)::text, '-') || ':' || coalesce(max(g.updated_at)::text, '-') from public.stem_growth_measurements g, w
      where g.crop_id = p_crop_id and g.year * 100 + g.week_number <= w.yw),
    (select count(*) || ':' || coalesce(max(n.updated_at)::text, '-') from public.plant_nodes n, w
      where n.crop_id = p_crop_id and n.created_at < w.week_end),
    (select count(*) || ':' || coalesce(max(s.updated_at)::text, '-') from public.measurement_stems s where s.crop_id = p_crop_id),
    (select count(*) || ':' || coalesce(max(a.updated_at)::text, '-') from public.weekly_harvest_afw a where a.crop_id = p_crop_id),
    (select count(*) || ':' || coalesce(max(l.logged_at)::text, '-') from public.weekly_harvest_afw_log l where l.crop_id = p_crop_id),
    (select count(*) || ':' || coalesce(max(b.created_at)::text, '-') from public.forecast_basis_settings b where b.crop_id = p_crop_id),
    (select count(*) || ':' || coalesce(max(q.reviewed_at)::text, '-') from public.data_quality_reviews q where q.crop_id = p_crop_id),
    (select c.updated_at::text || ':' || c.picking_stems || ':' || c.area_m2 from public.crops c where c.id = p_crop_id)
  ))
$$;

revoke execute on function public.forecast_input_signature(uuid, integer, integer) from public, anon;
grant  execute on function public.forecast_input_signature(uuid, integer, integer) to authenticated, service_role;
