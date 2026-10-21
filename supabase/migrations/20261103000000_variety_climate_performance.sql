-- Variety climate: crop_climate_hourly() rewritten for speed, same results
--
-- 2026-10-21: with Mathieu's zones assigned over months (needed for the
-- maturation study), the 20261101 version took longer than the statement
-- limit for 30+ days: it built every hour × measurement × assigned zone and
-- matched each against all of the period's readings without an index. This
-- version joins the readings to the variety's few assignments and counts each
-- hour's assigned zones once, so every step is hash-joinable; and it reads
-- each file's readings in one index lookup instead of one per file and zone. Same signature,
-- columns, rules and values (variety_climate_test.sql, and a row-by-row
-- comparison with the 20261101 version). Nothing else changes.

create or replace function public.crop_climate_hourly(p_crop_id uuid, p_from timestamptz, p_to timestamptz, p_as_of timestamptz default 'infinity')
returns table (
  hour_utc        timestamptz,
  local_date      date,
  local_hour      integer,
  metric          text,
  value           double precision,
  method          text,            -- mean | area_weighted | greenhouse
  zones_assigned  integer,
  zones_used      integer,
  coverage        numeric,         -- share of the variety's zones (or area) with a usable reading
  inputs          jsonb            -- [{zone, value, share, reading_id, file_id}]
)
language sql
stable
security invoker
set search_path = ''
as $$
  with crop as (
    select c.id, c.organization_id from public.crops c where c.id = p_crop_id
  ),
  src as (
    -- The organization's climate source (one per organization today).
    select s.id, s.time_zone, public.climate_greenhouse_zone_id(s.id) as gw
      from public.climate_sources s where s.organization_id = (select organization_id from crop)
     order by s.created_at limit 1
  ),
  cutoff as (select least(p_to, p_as_of) as t),
  -- Assignments as recorded at p_as_of.
  assigned as (
    select a.zone_id, z.source_label, a.area_share, a.valid_from, a.valid_until, a.change_id
      from public.crop_climate_zones a
      join public.climate_zones z on z.id = a.zone_id
     where a.crop_id = p_crop_id
       and a.recorded_at <= p_as_of
       and (a.superseded_at is null or a.superseded_at > p_as_of)
  ),
  -- Files in effect for their hour at p_as_of.
  files as (
    select f.id, f.hour_utc
      from public.climate_import_files f
     where f.source_id = (select id from src)
       and f.hour_utc >= p_from and f.hour_utc < (select t from cutoff)
       and p_to - p_from <= interval '400 days'
       and (case when p_as_of = 'infinity' then f.hour_state else public.climate_file_state_at(f.id, p_as_of) end) = 'active'
  ),
  -- The five measurements' readings of those files (the stored originals): one
  -- index lookup per file (not per file and zone); zone labels attached afterwards.
  r as (
    select fl.hour_utc, (fl.hour_utc at time zone (select time_zone from src)) as lt, x.metric, x.zone_id, x.value, x.id as reading_id, fl.id as file_id,
           x.value is not null and not (x.flags && array['not_numeric', 'unexpected_unit', 'out_of_range']) as usable
      from files fl
      cross join lateral (
        select x.zone_id, x.metric, x.value, x.id, x.flags
          from public.climate_readings x
         where x.file_id = fl.id
           and x.metric in ('air_temperature', 'relative_humidity', 'co2', 'irrigation_cumulative', 'radiation_sum')
        offset 0
      ) x
      join public.climate_zones z on z.id = x.zone_id
     where public.climate_is_measurement(x.metric, z.source_label)
  ),
  hours as (
    select distinct hour_utc, lt from r
  ),
  -- The variety's zones for each hour's local date (a handful of rows per hour).
  hour_zones as (
    select h.hour_utc, h.lt,
           count(*)::integer as n_assigned,
           bool_and(a.area_share is not null) as weighted,
           sum(a.area_share) as share_total,
           array_agg(a.source_label order by a.source_label) as labels
      from hours h
      join assigned a on a.valid_from <= h.lt::date and (a.valid_until is null or a.valid_until > h.lt::date)
     group by h.hour_utc, h.lt
  ),
  -- The readings of those zones (hash-joinable: readings × the variety's few assignments).
  ar as (
    select r.hour_utc, r.metric, r.value, r.usable, r.reading_id, r.file_id, a.source_label, a.area_share
      from r
      join assigned a on a.zone_id = r.zone_id and a.valid_from <= r.lt::date and (a.valid_until is null or a.valid_until > r.lt::date)
     where r.metric <> 'radiation_sum'
  ),
  present as (
    select hour_utc, metric,
           (count(*) filter (where usable))::integer as n_used,
           sum(area_share) filter (where usable) as share_used,
           sum(value * area_share) filter (where usable) as weighted_sum,
           avg(value) filter (where usable) as mean,
           array_agg(source_label) as labels,
           jsonb_agg(jsonb_build_object('zone', source_label, 'value', case when usable then value end, 'share', area_share, 'reading_id', reading_id, 'file_id', file_id)) as inputs
      from ar
     group by hour_utc, metric
  ),
  combined as (
    select hz.hour_utc, hz.lt, m.metric,
           case when hz.weighted then 'area_weighted' else 'mean' end as method,
           hz.n_assigned, coalesce(p.n_used, 0) as n_used,
           round(case when hz.weighted then coalesce(p.share_used, 0) / nullif(hz.share_total, 0) else coalesce(p.n_used, 0)::numeric / hz.n_assigned end, 4) as coverage,
           case when hz.weighted then p.weighted_sum / nullif(p.share_used, 0) else p.mean end as raw_value,
           -- Every assigned zone: its reading, or value null when it has none.
           (select jsonb_agg(e order by e->>'zone')
              from (select jsonb_array_elements(coalesce(p.inputs, '[]'::jsonb)) as e
                    union all
                    select jsonb_build_object('zone', l, 'value', null, 'share', (select a.area_share from assigned a where a.source_label = l limit 1), 'reading_id', null, 'file_id', null)
                      from unnest(hz.labels) l
                     where not (l = any (coalesce(p.labels, '{}')))) x) as inputs
      from hour_zones hz
      cross join (values ('air_temperature'), ('relative_humidity'), ('co2'), ('irrigation_cumulative')) m(metric)
      left join present p on p.hour_utc = hz.hour_utc and p.metric = m.metric
  ),
  -- Radiation: the greenhouse-wide reading, on days the variety has zones.
  radiation as (
    select rd.hour_utc, rd.lt, 'radiation_sum'::text as metric, 'greenhouse'::text as method,
           (select count(*)::integer from assigned a where a.valid_from <= rd.lt::date and (a.valid_until is null or a.valid_until > rd.lt::date)) as n_assigned,
           case when rd.usable then 1 else 0 end as n_used,
           case when rd.usable then 1.0 else 0.0 end::numeric as coverage,
           case when rd.usable then rd.value end as value,
           jsonb_build_array(jsonb_build_object('zone', 'Zone 1 (B6, greenhouse-wide)', 'value', case when rd.usable then rd.value end, 'share', null, 'reading_id', rd.reading_id, 'file_id', rd.file_id)) as inputs
      from r rd
     where rd.metric = 'radiation_sum' and rd.zone_id = (select gw from src)
  )
  select c.hour_utc, c.lt::date, extract(hour from c.lt)::integer, c.metric,
         case
           when c.n_used = 0 then null
           when c.metric = 'irrigation_cumulative' and c.coverage < 1 then null
           when c.coverage < 0.75 then null
           else c.raw_value
         end,
         c.method, c.n_assigned, c.n_used, c.coverage, c.inputs
    from combined c
  union all
  select g.hour_utc, g.lt::date, extract(hour from g.lt)::integer, g.metric, g.value, g.method, g.n_assigned, g.n_used, g.coverage, g.inputs
    from radiation g
   where g.n_assigned > 0
  order by 1, 4
$$;
