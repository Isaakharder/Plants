-- Projections › Weekly Plant Data: Fruit Loss % per calendar week
--
-- weekly_fruit_loss(crop, year) returns one row per ISO week of the year: the
-- fruit lost that week, the fruit on the plant at the start of the week, and
--
--   Fruit Loss % = fruit lost in W ÷ fruit on the plant at the start of W × 100
--
-- It sits beside Harvested/m², AFW and Picked kg, which all describe the same
-- calendar week. It replaces the visible Loss column; the +10 cohort loss in
-- set_harvest_cohorts() is unchanged (shown as Cohort Loss).
--
-- Rules (audited 2026-10-05):
--   * Node history comes from crop_node_weeks(): active nodes, one status per
--     node per week (the latest observation that week), any year.
--   * Fruit: a node recorded SetFruit, MatureGreen or BreakerFruit. It enters
--     the population in the week AFTER its first fruit-stage record, so fruit
--     that sets in W is never in W's population or numerator.
--   * A loss is a confirmed Aborted / Pruned record: one not followed by any
--     later non-loss record (later SetFruit, Harvested, … means the earlier
--     Aborted was a mis-tap). It dates from the first loss record after the
--     node's last non-loss record, and counts once, however often it is
--     repeated. Its kind (aborted / pruned) is the status recorded that week.
--   * Fruit on the plant at the start of W: fruit since before W, not
--     harvested before W, not lost before W, on a stem sampled in W (the
--     stem's first-to-last observed span covers W, as for sampled stems in
--     weekly_plant_data()).
--   * Fruit lost in W: fruit on the plant at the start of W whose confirmed
--     loss is in W. The numerator is always part of the denominator.
--   * Flower loss: a confirmed loss in W of a node with no fruit-stage record
--     before W (a flower, or a fruit set and lost between two visits). Kept
--     separate; never part of Fruit Loss %.
--   * Fruit Loss % is null when the week wasn't sampled or no fruit was on the
--     plant. Per-m² uses weekly_plant_data()'s sampled m².
--   * Nothing is redistributed between weeks or projected. A later live
--     record can retract an earlier loss, as it does for the cohort outcome.
--
-- SECURITY INVOKER: every table is read with the caller's RLS.

create or replace function public.weekly_fruit_loss(
  p_crop_id uuid,
  p_year integer,
  p_as_of timestamptz default now()
)
returns table (
  iso_week            integer,
  fruit_at_start      integer,
  fruit_lost          integer,
  fruit_aborted       integer,
  fruit_pruned        integer,
  flower_lost         integer,
  fruit_lost_per_m2   numeric,
  fruit_loss_percent  numeric,
  is_sampled          boolean,
  is_provisional      boolean
)
language sql
stable
security invoker
set search_path = ''
as $$
  with node_weeks as (
    select * from public.crop_node_weeks(p_crop_id)
  ),
  nodes as (
    select
      plant_node_id,
      measurement_stem_id,
      min(yw) filter (where status in ('SetFruit', 'MatureGreen', 'BreakerFruit')) as fruit_yw,
      min(yw) filter (where status = 'Harvested') as harvested_yw,
      max(yw) filter (where status not in ('Aborted', 'Pruned')) as last_live_yw
    from node_weeks
    group by plant_node_id, measurement_stem_id
  ),
  -- The confirmed loss: first loss record after the last non-loss record.
  losses as (
    select distinct on (n.plant_node_id) n.plant_node_id, nw.yw as loss_yw, nw.status as loss_status
    from nodes n
    join node_weeks nw on nw.plant_node_id = n.plant_node_id
    where nw.status in ('Aborted', 'Pruned')
      and (n.last_live_yw is null or nw.yw > n.last_live_yw)
    order by n.plant_node_id, nw.yw
  ),
  fates as (
    select n.*, l.loss_yw, l.loss_status
    from nodes n
    left join losses l using (plant_node_id)
  ),
  stem_spans as (
    select measurement_stem_id, min(yw) as first_yw, max(yw) as last_yw
    from node_weeks
    group by measurement_stem_id
  ),
  weeks as (
    select w.iso_week, p_year * 100 + w.iso_week as yw, w.sampled_m2, w.is_sampled, w.is_provisional
    from public.weekly_plant_data(p_crop_id, p_year, p_as_of) w
  ),
  per_week as (
    select
      w.*,
      (select count(*) from fates f join stem_spans s using (measurement_stem_id)
        where w.yw between s.first_yw and s.last_yw
          and f.fruit_yw < w.yw
          and (f.harvested_yw is null or f.harvested_yw >= w.yw)
          and (f.loss_yw is null or f.loss_yw >= w.yw))::integer as at_start,
      (select count(*) from fates f join stem_spans s using (measurement_stem_id)
        where w.yw between s.first_yw and s.last_yw
          and f.fruit_yw < w.yw
          and (f.harvested_yw is null or f.harvested_yw >= w.yw)
          and f.loss_yw = w.yw)::integer as lost,
      (select count(*) from fates f join stem_spans s using (measurement_stem_id)
        where w.yw between s.first_yw and s.last_yw
          and f.fruit_yw < w.yw
          and (f.harvested_yw is null or f.harvested_yw >= w.yw)
          and f.loss_yw = w.yw and f.loss_status = 'Aborted')::integer as aborted,
      (select count(*) from fates f
        where f.loss_yw = w.yw and (f.fruit_yw is null or f.fruit_yw >= w.yw))::integer as flowers
    from weeks w
  )
  select
    p.iso_week,
    p.at_start,
    p.lost,
    p.aborted,
    p.lost - p.aborted,
    p.flowers,
    case when p.is_sampled then p.lost / p.sampled_m2 end,
    case when p.is_sampled and p.at_start > 0 then p.lost * 100.0 / p.at_start end,
    p.is_sampled,
    p.is_provisional
  from per_week p
  order by p.iso_week
$$;

revoke execute on function public.weekly_fruit_loss(uuid, integer, timestamptz) from public, anon;
grant  execute on function public.weekly_fruit_loss(uuid, integer, timestamptz) to authenticated;
