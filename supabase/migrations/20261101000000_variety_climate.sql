-- Climate per variety: one combined reading per measurement and hour, the
-- single source for the Climate page and for projection climate inputs
--
-- Requested 2026-10-21. Data flow:
--   raw zone readings (climate_readings, untouched)
--     → crop_climate_hourly()   one value per variety, measurement and hour
--     → crop_climate_daily()    one value per variety, measurement and local date
--     → projection inputs       (src/features/climate/varietyClimate.ts, weekly)
-- Nothing is stored: values are recalculated from the original readings, and
-- every value carries what it was made from (zones, their readings, area
-- shares, assignment changes), so it can be reproduced.
--
-- Combining zones (temperature, RH, CO₂, cumulative irrigation):
--   * the zones the variety occupied on the reading's local date, as recorded
--     at p_as_of (crop_climate_zones is bitemporal);
--   * area-weighted when every one of those zones has an area share,
--     otherwise the plain mean ("mean"). Plants has no zone areas: on
--     2026-10-21 no assignment had a share, so every variety is a plain mean
--     until an owner enters shares in Settings › Climate;
--   * flagged or missing readings are left out, never counted as zero; the
--     hour is empty when the readings present cover less than 75 % of the
--     variety's zones (by share, or by count) — for irrigation, a running
--     total per zone, all zones are required (a partial mean would mix days).
-- Radiation sum is greenhouse-wide (cell B6): the one reading per hour is the
-- variety's value, for every day the variety has zones; it is never summed
-- or averaged across zones.
--
-- Running totals (irrigation, radiation): a day's value is the 23:00 reading
-- of the combined series; the day's running value only counts readings after
-- that day's restart (radiation restarts ~08:00, irrigation at 00:00); never a
-- sum or mean of snapshots. Hourly measurements: daily mean of the hours with
-- a value (min, max, hours present).
--
-- As of a moment (p_as_of; default: now, as currently recorded): only hours
-- before it, files received by then, the file that was in effect for each
-- hour then (rebuilt from climate_file_reviews), and the zone assignments as
-- recorded then. A forecast or backtest made at T can never see later
-- readings, later review decisions or later zone changes.

-- ---------------------------------------------------------------------------
-- Which file was in effect for an hour at a moment
-- ---------------------------------------------------------------------------

-- The file's state at p_as_of: the state after its last review by then;
-- before any review, the state it was stored with; null if not received yet.
create or replace function public.climate_file_state_at(p_file_id uuid, p_as_of timestamptz)
returns text
language sql
stable
security invoker
set search_path = ''
as $$
  select case
    when f.received_at > p_as_of then null
    else coalesce(
      (select r.state_after from public.climate_file_reviews r where r.file_id = f.id and r.reviewed_at <= p_as_of order by r.reviewed_at desc, r.id desc limit 1),
      (select r.state_before from public.climate_file_reviews r where r.file_id = f.id order by r.reviewed_at, r.id limit 1),
      f.hour_state)
  end
  from public.climate_import_files f
  where f.id = p_file_id
$$;

-- ---------------------------------------------------------------------------
-- Hourly
-- ---------------------------------------------------------------------------

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
  -- The five measurements' readings of those files (the stored originals).
  r as (
    select fl.hour_utc, (fl.hour_utc at time zone (select time_zone from src)) as lt, x.metric, x.zone_id, x.value, x.id as reading_id, fl.id as file_id,
           x.value is not null and not (x.flags && array['not_numeric', 'unexpected_unit', 'out_of_range']) as usable
      from files fl
      join public.climate_readings x on x.file_id = fl.id
      join public.climate_zones z on z.id = x.zone_id
     where public.climate_is_measurement(x.metric, z.source_label)
  ),
  hours as (
    select distinct hour_utc, lt from r
  ),
  -- Zone measurements: every assigned zone of the hour's local date, with its reading if any.
  zm as (
    select h.hour_utc, h.lt, m.metric, a.zone_id, a.source_label, a.area_share, rd.value, rd.reading_id, rd.file_id, coalesce(rd.usable, false) as usable
      from hours h
      cross join (values ('air_temperature'), ('relative_humidity'), ('co2'), ('irrigation_cumulative')) m(metric)
      join assigned a on a.valid_from <= h.lt::date and (a.valid_until is null or a.valid_until > h.lt::date)
      left join r rd on rd.hour_utc = h.hour_utc and rd.metric = m.metric and rd.zone_id = a.zone_id
  ),
  zone_hours as (
    select hour_utc, lt, metric,
           bool_and(area_share is not null) as weighted,
           count(*)::integer as n_assigned,
           (count(*) filter (where usable))::integer as n_used,
           sum(area_share) as share_total,
           sum(area_share) filter (where usable) as share_used,
           sum(value * area_share) filter (where usable) as weighted_sum,
           avg(value) filter (where usable) as mean,
           jsonb_agg(jsonb_build_object('zone', source_label, 'value', case when usable then value end, 'share', area_share, 'reading_id', reading_id, 'file_id', file_id)
                     order by source_label) as inputs
      from zm
     group by hour_utc, lt, metric
  ),
  combined as (
    select hour_utc, lt, metric,
           case when weighted then 'area_weighted' else 'mean' end as method,
           n_assigned, n_used,
           round(case when weighted then coalesce(share_used, 0) / nullif(share_total, 0) else n_used::numeric / n_assigned end, 4) as coverage,
           case when weighted then weighted_sum / nullif(share_used, 0) else mean end as raw_value,
           inputs
      from zone_hours
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

-- ---------------------------------------------------------------------------
-- Daily
-- ---------------------------------------------------------------------------

-- Per local date in [p_from, p_to] and measurement:
--   hourly measurements  value = mean of the hours with a value; min, max;
--                        status final (past day, 24 hours) | partial (past
--                        day, fewer hours) | running (today) | no_data
--   running totals       value = the 23:00 combined reading; status final |
--                        running (today or later, before 23:00) | incomplete
--                        (past, no 23:00 value) | no_data; running_value /
--                        running_hour: the latest value after the day's restart
create or replace function public.crop_climate_daily(p_crop_id uuid, p_from date, p_to date, p_as_of timestamptz default 'infinity')
returns table (
  local_date      date,
  metric          text,
  value           double precision,
  status          text,
  hours           integer,
  min_value       double precision,
  max_value       double precision,
  running_value   double precision,
  running_hour    integer,
  restart_hour    integer,
  method          text,
  zones_assigned  integer,
  min_coverage    numeric
)
language sql
stable
security invoker
set search_path = ''
as $$
  with src as (
    select s.time_zone from public.climate_sources s
     where s.organization_id = (select organization_id from public.crops where id = p_crop_id)
     order by s.created_at limit 1
  ),
  -- The moment the day is judged at: now, or p_as_of for a reproduction.
  judge as (
    select (least(now(), p_as_of) at time zone (select time_zone from src)) as lt
  ),
  -- One day earlier, so the first day's restart can be seen.
  h as (
    select * from public.crop_climate_hourly(
      p_crop_id,
      ((p_from - 1)::timestamp at time zone (select time_zone from src)),
      ((p_to + 1)::timestamp at time zone (select time_zone from src)),
      p_as_of)
  ),
  seq as (
    select h.*, h.value < lag(h.value) over (partition by h.metric order by h.hour_utc) - 0.05 as fell
      from h where h.value is not null
  ),
  restarts as (
    select metric, local_date, min(hour_utc) as restart_utc from seq where fell group by metric, local_date
  ),
  days as (
    select g::date as d, m.metric, m.kind
      from generate_series(p_from, p_to, interval '1 day') g
      cross join (values ('air_temperature', 'hourly'), ('relative_humidity', 'hourly'), ('co2', 'hourly'),
                         ('irrigation_cumulative', 'running'), ('radiation_sum', 'running')) m(metric, kind)
  ),
  agg as (
    select metric, local_date,
           (count(*) filter (where value is not null))::integer as n,
           avg(value) as mean, min(value) as mn, max(value) as mx,
           max(method) as method, max(zones_assigned) as zones_assigned, min(coverage) as min_coverage
      from h group by metric, local_date
  )
  select
    d.d, d.metric,
    case when d.kind = 'hourly' then a.mean else fin.value end,
    case
      when a.local_date is null and d.d < (select lt::date from judge) then 'no_data'
      when d.kind = 'hourly' then
        case when d.d >= (select lt::date from judge) then 'running'
             when coalesce(a.n, 0) = 0 then 'no_data'
             when a.n < 24 then 'partial' else 'final' end
      when fin.value is not null then 'final'
      when d.d > (select lt::date from judge) then 'running'
      when d.d = (select lt::date from judge) and extract(hour from (select lt from judge)) <= 23 then 'running'
      else 'incomplete'
    end,
    coalesce(a.n, 0),
    case when d.kind = 'hourly' then a.mn end,
    case when d.kind = 'hourly' then a.mx end,
    run.value, run.local_hour,
    extract(hour from (rs.restart_utc at time zone (select time_zone from src)))::integer,
    a.method, a.zones_assigned, a.min_coverage
  from days d
  left join agg a on a.metric = d.metric and a.local_date = d.d
  left join restarts rs on rs.metric = d.metric and rs.local_date = d.d
  left join lateral (
    select s.value from seq s where d.kind = 'running' and s.metric = d.metric and s.local_date = d.d and s.local_hour = 23
  ) fin on true
  left join lateral (
    select s.value, s.local_hour from seq s
     where d.kind = 'running' and s.metric = d.metric and s.local_date = d.d and rs.restart_utc is not null and s.hour_utc >= rs.restart_utc
     order by s.hour_utc desc limit 1
  ) run on true
  order by d.d, d.metric
$$;

revoke execute on function public.climate_file_state_at(uuid, timestamptz),
  public.crop_climate_hourly(uuid, timestamptz, timestamptz, timestamptz),
  public.crop_climate_daily(uuid, date, date, timestamptz)
  from public, anon;
grant execute on function public.climate_file_state_at(uuid, timestamptz),
  public.crop_climate_hourly(uuid, timestamptz, timestamptz, timestamptz),
  public.crop_climate_daily(uuid, date, date, timestamptz)
  to authenticated;
