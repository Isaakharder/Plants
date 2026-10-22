-- Plants › Metrics: weekly fruit metrics per variety, averaged per stem.
--
-- Read-only and additive: one function, no table changes.
--
-- weekly_variety_metrics(org): one row per variety and ISO week in which at
-- least one of its sampled stems was visited.
--   stems        active stems with visit evidence that week (crop_stem_weeks:
--                a status record, a stem check, a growth reading or a node
--                added; the same rule as Projections › Weekly Plant Data)
--   rows_        distinct rows those stems belong to
--   set_fruit    fruit in Set Fruit on those stems
--   fruit_load   fruit on the plant: Set Fruit + Mature Green + Breaker
--                (not flowers, harvested, aborted or pruned)
--   breakers     fruit in Breaker
-- Counts include side shoots. A node's state in week W is its latest status
-- recorded in or before W (crop_node_weeks), but only on stems visited in W:
-- a stem that wasn't visited in W isn't counted in W at all, and a week
-- without any visit has no row. Active nodes only. Duplicate records (two
-- active nodes with the same main-stem number on a stem, or the same side-shoot
-- label on the same parent: the Plants page's rule) count once, using the
-- record with the newest observation. Averages are the counts ÷ stems.
--
-- SECURITY INVOKER: every table is read with the caller's RLS.

create or replace function public.weekly_variety_metrics(p_organization_id uuid)
returns table (
  crop_id     uuid,
  yw          integer,   -- ISO year * 100 + ISO week
  stems       integer,
  rows_       integer,
  set_fruit   integer,
  fruit_load  integer,
  breakers    integer
)
language sql
stable
security invoker
set search_path = ''
as $$
  with crops as (
    select c.id from public.crops c where c.organization_id = p_organization_id
  ),
  visits as materialized (
    select c.id as crop_id, w.measurement_stem_id as stem_id, w.yw
      from crops c cross join lateral public.crop_stem_weeks(c.id, 'infinity') w
     where w.visited
  ),
  -- Each node's status from the week it was recorded until its next recorded week.
  spans as materialized (
    select nw.plant_node_id, nw.measurement_stem_id as stem_id, nw.yw, nw.status,
           lead(nw.yw) over (partition by nw.plant_node_id order by nw.yw) as next_yw
      from crops c cross join lateral public.crop_node_weeks(c.id) nw
  ),
  -- Each node's identity on its stem: duplicates share a key.
  node_keys as (
    select n.id,
           case when n.is_side_shoot and n.node_label is not null then 'shoot:' || n.parent_node_id || ':' || n.node_label
                when n.is_side_shoot then 'node:' || n.id
                else 'main:' || n.node_number end as node_key
      from public.plant_nodes n
      join crops c on c.id = n.crop_id
     where n.is_active
  ),
  -- On each visited stem and week: each node's latest status in or before that week.
  states as (
    select v.crop_id, v.stem_id, v.yw, sp.plant_node_id, sp.status, sp.yw as status_yw
      from visits v
      join spans sp on sp.stem_id = v.stem_id and sp.yw <= v.yw and (sp.next_yw is null or sp.next_yw > v.yw)
  ),
  -- One record per duplicate group: the one with the newest observation.
  counted as (
    select distinct on (st.stem_id, st.yw, k.node_key) st.*
      from states st
      join node_keys k on k.id = st.plant_node_id
     order by st.stem_id, st.yw, k.node_key, st.status_yw desc, st.plant_node_id
  ),
  stem_counts as (
    select v.crop_id, v.yw, v.stem_id, s.measurement_row_id,
           count(c.plant_node_id) filter (where c.status = 'SetFruit') as set_fruit,
           count(c.plant_node_id) filter (where c.status in ('SetFruit', 'MatureGreen', 'BreakerFruit')) as fruit_load,
           count(c.plant_node_id) filter (where c.status = 'BreakerFruit') as breakers
      from visits v
      join public.measurement_stems s on s.id = v.stem_id
      left join counted c on c.stem_id = v.stem_id and c.yw = v.yw
     group by v.crop_id, v.yw, v.stem_id, s.measurement_row_id
  )
  select crop_id, yw,
         count(*)::integer,
         count(distinct measurement_row_id)::integer,
         sum(set_fruit)::integer,
         sum(fruit_load)::integer,
         sum(breakers)::integer
    from stem_counts
   group by crop_id, yw
   order by crop_id, yw
$$;

revoke execute on function public.weekly_variety_metrics(uuid) from public, anon;
grant  execute on function public.weekly_variety_metrics(uuid) to authenticated;
