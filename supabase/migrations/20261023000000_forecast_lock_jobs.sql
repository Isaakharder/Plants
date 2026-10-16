-- Plants: server-side locking of official forecasts (job queue)
--
-- Additive only. When a sampling completion reaches the database, a trigger
-- queues a lock job. A server-side worker (service role; see
-- src/features/forecast/server/lockWorker.ts) claims due jobs, computes the
-- forecast with the shared engine and stores it with lock_forecast_run(). No
-- browser or phone has to be open.
--
--   sampling_week_events.stems_checked_seen / stems_expected_seen
--       What the collector showed when the worker marked sampling complete
--       ("54 of 56 stems checked"), including checks still queued on the
--       phone. The lock waits until at least that many checks have reached
--       the database.
--   forecast_lock_jobs           one job per completion; its state and history
--   forecast_lock_readiness(id)  is that completion's sampling data in?
--   claim_forecast_lock_job()    the worker takes the next due, ready job
--   finish_forecast_lock_job()   … records the stored (or existing) forecast
--   fail_forecast_lock_job()     … or a failure, retried with back-off
--
-- Safety:
--   * One job per completion (unique), one forecast per crop and week (the
--     forecast_runs unique key): retries and duplicate workers can't create a
--     second forecast or overwrite one.
--   * The observation cutoff is the completion's observed_at; official / late
--     is decided by lock_forecast_run() from the server's clock.
--   * A completion that is no longer the week's latest event (sampling was
--     reopened) is superseded; the newer completion has its own job.
--   * A claimed job holds a 10-minute lease: if the worker dies, the job is
--     claimed again after it expires.
--   * Failures retry after 1, 2, 4 … minutes (at most an hour) for 7 days;
--     sampling data that never arrives fails the job after 7 days. Nothing
--     is ever locked from incomplete data to meet a deadline: a forecast
--     stored after its first target week began is 'late'.

alter table public.sampling_week_events
  add column stems_checked_seen integer check (stems_checked_seen >= 0),
  add column stems_expected_seen integer check (stems_expected_seen >= 0);

comment on column public.sampling_week_events.stems_checked_seen is
  'Stems shown as checked on the completing device (synced or still queued) when sampling was marked complete.';

create table public.forecast_lock_jobs (
  id                 bigint generated always as identity primary key,
  organization_id    uuid not null,
  crop_id            uuid not null,
  year               integer not null,
  week               integer not null,
  sampling_event_id  uuid not null unique references public.sampling_week_events (id),
  status             text not null default 'pending'
                     check (status in ('pending', 'waiting_for_sync', 'running', 'retry', 'done', 'superseded', 'failed')),
  attempts           integer not null default 0,
  next_attempt_at    timestamptz not null default now(),
  lease_until        timestamptz,
  last_error         text,
  run_id             uuid references public.forecast_runs (id),
  run_kind           text check (run_kind in ('official', 'late')),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint forecast_lock_jobs_crop_fkey
    foreign key (organization_id, crop_id)
    references public.crops (organization_id, id) on delete cascade
);

create index forecast_lock_jobs_due_idx on public.forecast_lock_jobs (next_attempt_at) where status in ('pending', 'waiting_for_sync', 'retry', 'running');

comment on table public.forecast_lock_jobs is 'Server-side forecast locking: one job per sampling completion. Written only by the trigger and the worker functions.';

alter table public.forecast_lock_jobs enable row level security;
create policy "Members can read lock jobs"
  on public.forecast_lock_jobs for select to authenticated
  using (public.is_org_member(organization_id));
revoke all on public.forecast_lock_jobs from anon, authenticated;
grant select on public.forecast_lock_jobs to authenticated;

-- Queue a job for every completion that reaches the database.
create or replace function public.forecast_lock_jobs_enqueue()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.event = 'completed' then
    insert into public.forecast_lock_jobs (organization_id, crop_id, year, week, sampling_event_id)
    values (new.organization_id, new.crop_id, new.year, new.week_number, new.id)
    on conflict (sampling_event_id) do nothing;
  end if;
  return new;
end;
$$;

create trigger sampling_week_events_enqueue_lock
  after insert on public.sampling_week_events
  for each row execute function public.forecast_lock_jobs_enqueue();

revoke execute on function public.forecast_lock_jobs_enqueue() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Readiness
-- ---------------------------------------------------------------------------
--
-- ready      the completion is the week's latest event and at least as many
--            stems are confirmed checked in the database as the completing
--            device showed
-- superseded a later event (reopened / completed again) replaced it
-- locked     the week already has a stored forecast

create or replace function public.forecast_lock_readiness(p_sampling_event_id uuid)
returns table (state text, checked_in_db integer, checked_seen integer, detail text)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_event public.sampling_week_events;
  v_latest uuid;
  v_checked integer;
begin
  select * into v_event from public.sampling_week_events where id = p_sampling_event_id;
  if v_event.id is null
     or not (public.is_org_member(v_event.organization_id) or coalesce(current_setting('request.jwt.claims', true)::jsonb ->> 'role', '') = 'service_role') then
    raise exception 'Sampling completion not found' using errcode = '42501';
  end if;
  if exists (select 1 from public.forecast_runs r where r.crop_id = v_event.crop_id and r.origin_year = v_event.year and r.origin_week = v_event.week_number) then
    return query select 'locked', null::integer, v_event.stems_checked_seen, 'This week already has a locked forecast.';
    return;
  end if;
  select e.id into v_latest from public.sampling_week_events e
   where e.crop_id = v_event.crop_id and e.year = v_event.year and e.week_number = v_event.week_number
   order by e.recorded_at desc, e.id desc limit 1;
  if v_latest <> v_event.id then
    return query select 'superseded', null::integer, v_event.stems_checked_seen, 'Sampling was reopened or completed again after this.';
    return;
  end if;
  -- Stems whose latest check this week says checked.
  select count(*)::integer into v_checked from (
    select distinct on (v.measurement_stem_id) v.checked
    from public.stem_visits v
    where v.crop_id = v_event.crop_id and v.year = v_event.year and v.week_number = v_event.week_number
    order by v.measurement_stem_id, v.observed_at desc, v.recorded_at desc, v.id desc
  ) latest where latest.checked;
  if v_checked < coalesce(v_event.stems_checked_seen, 0) then
    return query select 'waiting_for_sync', v_checked, v_event.stems_checked_seen,
      format('%s of the %s stem checks seen at completion have reached the server.', v_checked, v_event.stems_checked_seen);
    return;
  end if;
  return query select 'ready', v_checked, v_event.stems_checked_seen, null::text;
end;
$$;

revoke execute on function public.forecast_lock_readiness(uuid) from public, anon;
grant  execute on function public.forecast_lock_readiness(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Worker functions (service role only)
-- ---------------------------------------------------------------------------

create or replace function public.claim_forecast_lock_job()
returns setof public.forecast_lock_jobs
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.forecast_lock_jobs;
  v_ready record;
begin
  if coalesce(current_setting('request.jwt.claims', true)::jsonb ->> 'role', '') <> 'service_role' then
    raise exception 'Only the lock worker can claim jobs' using errcode = '42501';
  end if;
  loop
    select * into v_job from public.forecast_lock_jobs j
     where (j.status in ('pending', 'waiting_for_sync', 'retry') and j.next_attempt_at <= now())
        or (j.status = 'running' and j.lease_until < now())
     order by j.next_attempt_at, j.id
     limit 1
     for update skip locked;
    if v_job.id is null then
      return;
    end if;
    select * into v_ready from public.forecast_lock_readiness(v_job.sampling_event_id);
    if v_ready.state = 'superseded' or v_ready.state = 'locked' then
      update public.forecast_lock_jobs set status = case when v_ready.state = 'locked' then 'done' else 'superseded' end,
             last_error = v_ready.detail, lease_until = null, updated_at = now(),
             run_id = (select r.id from public.forecast_runs r where r.crop_id = v_job.crop_id and r.origin_year = v_job.year and r.origin_week = v_job.week),
             run_kind = (select r.kind from public.forecast_runs r where r.crop_id = v_job.crop_id and r.origin_year = v_job.year and r.origin_week = v_job.week)
       where id = v_job.id;
    elsif v_ready.state = 'waiting_for_sync' then
      update public.forecast_lock_jobs
         set status = case when v_job.created_at < now() - interval '7 days' then 'failed' else 'waiting_for_sync' end,
             last_error = v_ready.detail || case when v_job.created_at < now() - interval '7 days' then ' Gave up after 7 days.' else '' end,
             next_attempt_at = now() + interval '2 minutes', lease_until = null, updated_at = now()
       where id = v_job.id;
    else
      update public.forecast_lock_jobs
         set status = 'running', attempts = attempts + 1, lease_until = now() + interval '10 minutes', updated_at = now()
       where id = v_job.id
       returning * into v_job;
      return next v_job;
      return;
    end if;
  end loop;
end;
$$;

create or replace function public.finish_forecast_lock_job(p_job_id bigint, p_run_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if coalesce(current_setting('request.jwt.claims', true)::jsonb ->> 'role', '') <> 'service_role' then
    raise exception 'Only the lock worker can finish jobs' using errcode = '42501';
  end if;
  update public.forecast_lock_jobs
     set status = 'done', run_id = p_run_id, run_kind = (select kind from public.forecast_runs where id = p_run_id),
         lease_until = null, last_error = null, updated_at = now()
   where id = p_job_id;
end;
$$;

create or replace function public.fail_forecast_lock_job(p_job_id bigint, p_error text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if coalesce(current_setting('request.jwt.claims', true)::jsonb ->> 'role', '') <> 'service_role' then
    raise exception 'Only the lock worker can fail jobs' using errcode = '42501';
  end if;
  update public.forecast_lock_jobs
     set status = case when created_at < now() - interval '7 days' then 'failed' else 'retry' end,
         next_attempt_at = now() + least(interval '1 hour', interval '1 minute' * power(2, least(attempts, 6))),
         last_error = left(p_error, 1000), lease_until = null, updated_at = now()
   where id = p_job_id;
end;
$$;

revoke execute on function public.claim_forecast_lock_job() from public, anon, authenticated;
revoke execute on function public.finish_forecast_lock_job(bigint, uuid) from public, anon, authenticated;
revoke execute on function public.fail_forecast_lock_job(bigint, text) from public, anon, authenticated;
grant  execute on function public.claim_forecast_lock_job() to service_role;
grant  execute on function public.finish_forecast_lock_job(bigint, uuid) to service_role;
grant  execute on function public.fail_forecast_lock_job(bigint, text) to service_role;

-- The worker reads crops' records with the service role (RLS bypassed); it writes only through the functions above.
grant select on public.crops, public.measurement_stems, public.plant_nodes, public.node_observations, public.stem_growth_measurements,
  public.stem_visits, public.sampling_week_events, public.weekly_harvest_afw, public.weekly_harvest_afw_log, public.data_quality_reviews,
  public.forecast_runs, public.forecast_run_weeks, public.forecast_lock_jobs, public.measurement_rows
  to service_role;
grant execute on function public.crop_quality_flags(uuid, timestamptz), public.sampling_weeks(uuid, integer, timestamptz),
  public.crop_stem_weeks(uuid, timestamptz), public.iso_weeks_in_year(integer) to service_role;
