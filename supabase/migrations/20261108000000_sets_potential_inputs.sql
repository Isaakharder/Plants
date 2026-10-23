-- Plants: inputs of the experimental Sets production potential
--
-- Read-only functions over Plants' own observations; nothing is stored and no
-- existing table, function or record changes. Both SECURITY INVOKER: every
-- table is read with the caller's RLS.
--
-- 1. weekly_new_sets(crop, year): weekly_plant_data()'s Sets/m² with how many
--    of each week's new sets look like catch-up rather than fruit set that
--    week:
--      catchup_sets     first recorded already set, at a node position at or
--                       below a node recorded in an earlier week on the same
--                       stem or side shoot: a position missed earlier;
--      first_seen_set   first recorded already set (no earlier flower
--                       record). Normal weeks have a mix; when nearly all of
--                       a week's are, it may be catching up fruit that set
--                       earlier (e.g. the week after recording began).
--
-- 2. set_cohort_outcomes(crop, year): per set week (cohort), how many peppers
--    were harvested, aborted and pruned at each age 0 … 10 weeks after set,
--    how many resolved later than that, and how many are still on the plant.
--    A pepper's loss week is the week of its final Aborted/Pruned record
--    (after its last live record; an earlier mis-tap doesn't count). A pepper
--    with a Harvested record counts as harvested whatever its later records
--    (as in set_harvest_cohorts). Still-on-plant peppers are neither
--    harvested nor lost; the counts add up to the cohort's sets.

create or replace function public.weekly_new_sets(
  p_crop_id uuid,
  p_year integer,
  p_as_of timestamptz default now()
)
returns table (
  iso_week integer,
  sets_per_m2 numeric,
  is_sampled boolean,
  is_baseline boolean,
  is_provisional boolean,
  new_sets integer,
  catchup_sets integer,
  first_seen_set integer
)
language sql
stable
security invoker
set search_path = ''
as $$
  with stages as (
    select s.plant_node_id, s.measurement_stem_id, s.first_yw, s.set_yw, n.node_number, n.parent_node_id
      from public.crop_node_stages(p_crop_id) s
      join public.plant_nodes n on n.id = s.plant_node_id
  ),
  first_seen as (
    select s.set_yw % 100 as iso_week,
           count(*) filter (where exists (
             select 1 from stages e
              where e.measurement_stem_id = s.measurement_stem_id
                and e.parent_node_id is not distinct from s.parent_node_id
                and e.first_yw < s.first_yw
                and e.node_number >= s.node_number
           ))::integer as catchup,
           count(*)::integer as first_seen_set
      from stages s
     where s.set_yw / 100 = p_year
       and s.first_yw = s.set_yw
     group by 1
  )
  select
    w.iso_week,
    w.sets_per_m2,
    w.is_sampled,
    w.is_baseline,
    w.is_provisional,
    w.new_sets,
    coalesce(f.catchup, 0),
    coalesce(f.first_seen_set, 0)
  from public.weekly_plant_data(p_crop_id, p_year, p_as_of) w
  left join first_seen f on f.iso_week = w.iso_week
  order by w.iso_week;
$$;

revoke execute on function public.weekly_new_sets(uuid, integer, timestamptz) from public, anon;
grant execute on function public.weekly_new_sets(uuid, integer, timestamptz) to authenticated;

create or replace function public.set_cohort_outcomes(
  p_crop_id uuid,
  p_year integer
)
returns table (
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
  with stages as (
    select s.* from public.crop_node_stages(p_crop_id) s
  ),
  baseline as (
    select min(first_yw) as yw from stages
  ),
  weeks as (
    select w.plant_node_id, w.yw, w.week_start, w.status from public.crop_node_weeks(p_crop_id) w
  ),
  fates as (
    select
      s.plant_node_id,
      s.set_yw,
      s.set_week_start,
      s.latest_status,
      case when s.harvested_week_start is not null then (s.harvested_week_start - s.set_week_start) / 7 end as harvest_age,
      case when s.harvested_week_start is null and s.latest_status in ('Aborted', 'Pruned') then (
        select (min(w.week_start) - s.set_week_start) / 7
          from weeks w
         where w.plant_node_id = s.plant_node_id
           and w.status = s.latest_status
           and w.yw > coalesce((select max(l.yw) from weeks l where l.plant_node_id = s.plant_node_id and l.status not in ('Aborted', 'Pruned')), 0)
      ) end as loss_age
    from stages s
    where s.set_yw is not null and s.set_yw / 100 = p_year
  )
  select
    f.set_yw / 100,
    f.set_yw % 100,
    f.set_yw = (select yw from baseline),
    count(*)::integer,
    array(select count(x.plant_node_id)::integer from generate_series(0, 10) a left join fates x on x.set_yw = f.set_yw and x.harvest_age = a group by a order by a),
    array(select count(x.plant_node_id)::integer from generate_series(0, 10) a left join fates x on x.set_yw = f.set_yw and x.latest_status = 'Aborted' and x.loss_age = a group by a order by a),
    array(select count(x.plant_node_id)::integer from generate_series(0, 10) a left join fates x on x.set_yw = f.set_yw and x.latest_status = 'Pruned' and x.loss_age = a group by a order by a),
    count(*) filter (where f.harvest_age > 10 or f.loss_age > 10)::integer,
    count(*) filter (where f.harvest_age is null and f.loss_age is null)::integer
  from fates f
  group by f.set_yw
  order by f.set_yw;
$$;

revoke execute on function public.set_cohort_outcomes(uuid, integer) from public, anon;
grant execute on function public.set_cohort_outcomes(uuid, integer) to authenticated;
