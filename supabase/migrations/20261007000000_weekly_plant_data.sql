-- Projections › Weekly Plant Data
--
-- weekly_plant_data(crop, year) returns one row per ISO week of the year
-- (52 or 53) summarising what was observed on the crop's sampled plants:
-- how many peppers entered SetFruit, BreakerFruit and Harvested that week, the
-- number of sampled stems, and the sampled area those stems represent.
--
-- Rules (audited and approved, 2026-10-05):
--   * A node's observations in one week are reduced to the latest one
--     (observed_at, then recorded_at), so a corrected mis-tap never counts.
--   * A stage counts once per node, in the first week the node was recorded at
--     that stage, looking across years. Repeated / carried-forward statuses
--     never count again. Missing stages are never inferred.
--   * Side shoots count like any node. Nodes removed in the collector
--     (is_active = false) are ignored, as on the collector canvas.
--   * Sampled stems in a week: stems whose first-to-last observed span covers
--     that week (a week inside the span with nothing recorded still counts).
--   * Sampled m² = sampled stems ÷ (picking_stems ÷ area_m2), unrounded.
--   * Per-m² values are null in weeks with no sampled stems.
--   * is_baseline: the crop's first sampled week (no earlier visit, so its
--     counts may include stages reached before sampling began).
--   * is_provisional: the current greenhouse week (America/Toronto), whose
--     sampling may still be under way.
--
-- SECURITY INVOKER: every table is read with the caller's RLS, so a crop of
-- another organization (or no crop at all) yields no rows.

create or replace function public.weekly_plant_data(
  p_crop_id uuid,
  p_year integer,
  -- The moment that defines the current (provisional) week. Tests pass a fixed time.
  p_as_of timestamptz default now()
)
returns table (
  iso_week          integer,
  sampled_stems     integer,
  sampled_m2        numeric,
  new_sets          integer,
  new_breakers      integer,
  new_harvested     integer,
  sets_per_m2       numeric,
  breakers_per_m2   numeric,
  harvested_per_m2  numeric,
  is_sampled        boolean,
  is_baseline       boolean,
  is_provisional    boolean
)
language sql
stable
security invoker
set search_path = ''
as $$
  with crop as (
    select c.id, c.picking_stems::numeric / c.area_m2 as stems_per_m2
    from public.crops c
    where c.id = p_crop_id
  ),
  -- One status per node per week: the latest observation that week.
  node_weeks as (
    select distinct on (o.plant_node_id, o.year, o.week_number)
      o.plant_node_id,
      n.measurement_stem_id,
      o.year * 100 + o.week_number as yw,
      o.status
    from public.node_observations o
    join public.plant_nodes n on n.id = o.plant_node_id and n.is_active
    where o.crop_id = (select id from crop)
    order by o.plant_node_id, o.year, o.week_number, o.observed_at desc, o.recorded_at desc, o.id desc
  ),
  -- First week each node was recorded at each stage (any year).
  stage_entries as (
    select
      plant_node_id,
      min(yw) filter (where status = 'SetFruit')     as set_yw,
      min(yw) filter (where status = 'BreakerFruit') as breaker_yw,
      min(yw) filter (where status = 'Harvested')    as harvested_yw
    from node_weeks
    group by plant_node_id
  ),
  stem_spans as (
    select measurement_stem_id, min(yw) as first_yw, max(yw) as last_yw
    from node_weeks
    group by measurement_stem_id
  ),
  weeks as (
    select w as iso_week, p_year * 100 + w as yw
    from generate_series(1, public.iso_weeks_in_year(p_year)) as w
  ),
  current_week as (
    select extract(isoyear from p_as_of at time zone 'America/Toronto')::integer * 100
         + extract(week from p_as_of at time zone 'America/Toronto')::integer as yw
  ),
  per_week as (
    select
      w.iso_week,
      w.yw,
      (select count(*) from stem_spans s where w.yw between s.first_yw and s.last_yw)::integer as sampled_stems,
      (select count(*) from stage_entries e where e.set_yw = w.yw)::integer as new_sets,
      (select count(*) from stage_entries e where e.breaker_yw = w.yw)::integer as new_breakers,
      (select count(*) from stage_entries e where e.harvested_yw = w.yw)::integer as new_harvested
    from weeks w
  )
  select
    p.iso_week,
    p.sampled_stems,
    case when p.sampled_stems > 0 then p.sampled_stems / c.stems_per_m2 end,
    p.new_sets,
    p.new_breakers,
    p.new_harvested,
    case when p.sampled_stems > 0 then p.new_sets      / (p.sampled_stems / c.stems_per_m2) end,
    case when p.sampled_stems > 0 then p.new_breakers  / (p.sampled_stems / c.stems_per_m2) end,
    case when p.sampled_stems > 0 then p.new_harvested / (p.sampled_stems / c.stems_per_m2) end,
    p.sampled_stems > 0,
    coalesce(p.yw = (select min(first_yw) from stem_spans), false),
    p.yw = (select yw from current_week)
  from per_week p
  cross join crop c
  order by p.iso_week
$$;

revoke execute on function public.weekly_plant_data(uuid, integer, timestamptz) from public, anon;
grant  execute on function public.weekly_plant_data(uuid, integer, timestamptz) to authenticated;
