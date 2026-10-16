-- forecast_lock_jobs: queued by completion, waits for synced checks,
-- supersedes reopened weeks, claims with a lease, finishes and retries, and is
-- worker-only (service role).
--
-- Runs inside a transaction that is always rolled back.
-- Prints {"result": "forecast_lock_jobs tests passed"} on success.

begin;

insert into auth.users (id, email, aud, role) values
  ('aaaaaaaa-0000-4000-8000-00000000f901', 'flj-test-a@example.invalid', 'authenticated', 'authenticated');
insert into public.organizations (id, name) values ('aaaaaaaa-0000-4000-8000-00000000f9a0', 'FLJ Org A');
insert into public.organization_members (organization_id, user_id, role) values
  ('aaaaaaaa-0000-4000-8000-00000000f9a0', 'aaaaaaaa-0000-4000-8000-00000000f901', 'owner');
insert into public.crops (id, organization_id, name, color, planting_date, pullout_date, area_m2, picking_stems) values
  ('aaaaaaaa-0000-4000-8000-00000000f9c1', 'aaaaaaaa-0000-4000-8000-00000000f9a0', 'Crop A', 'red', '2025-12-01', '2027-12-01', 100, 700);
insert into public.measurement_rows (id, organization_id, crop_id, row_name) values
  ('aaaaaaaa-0000-4000-8000-00000000f911', 'aaaaaaaa-0000-4000-8000-00000000f9a0', 'aaaaaaaa-0000-4000-8000-00000000f9c1', 'Row A');
insert into public.measurement_stems (id, organization_id, crop_id, measurement_row_id, stem_name)
select ('aaaaaaaa-0000-4000-8000-00000000f92' || s)::uuid, 'aaaaaaaa-0000-4000-8000-00000000f9a0', 'aaaaaaaa-0000-4000-8000-00000000f9c1',
       'aaaaaaaa-0000-4000-8000-00000000f911', 'S' || s
from generate_series(1, 3) s;

create temporary table cw on commit drop as
select extract(isoyear from now() at time zone 'America/Toronto')::integer as y,
       extract(week from now() at time zone 'America/Toronto')::integer as w;
grant select on cw to authenticated, service_role;

-- As the member: two stems checked so far on the server, the phone saw three when completing.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-4000-8000-00000000f901","role":"authenticated"}', true);
insert into public.stem_visits (id, organization_id, crop_id, measurement_stem_id, year, week_number, checked, observed_at)
select gen_random_uuid(), 'aaaaaaaa-0000-4000-8000-00000000f9a0', 'aaaaaaaa-0000-4000-8000-00000000f9c1', ('aaaaaaaa-0000-4000-8000-00000000f92' || s)::uuid,
       (select y from cw), (select w from cw), true, now()
from generate_series(1, 2) s;
insert into public.sampling_week_events (id, organization_id, crop_id, year, week_number, event, stems_checked_seen, stems_expected_seen) values
  ('aaaaaaaa-0000-4000-8000-00000000f9e1', 'aaaaaaaa-0000-4000-8000-00000000f9a0', 'aaaaaaaa-0000-4000-8000-00000000f9c1', (select y from cw), (select w from cw), 'completed', 3, 3);

do $$
declare r record;
begin
  -- The completion queued a job, visible to members.
  select * into r from public.forecast_lock_jobs where sampling_event_id = 'aaaaaaaa-0000-4000-8000-00000000f9e1';
  if r.status <> 'pending' then raise exception 'FAIL: job queued %', r; end if;
  select * into r from public.forecast_lock_readiness('aaaaaaaa-0000-4000-8000-00000000f9e1');
  if r.state <> 'waiting_for_sync' or r.checked_in_db <> 2 or r.checked_seen <> 3 then raise exception 'FAIL: readiness %', r; end if;
  -- Members can't claim or change jobs.
  begin
    perform public.claim_forecast_lock_job();
    raise exception 'FAIL: a member claimed a job';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.forecast_lock_jobs set status = 'done';
    raise exception 'FAIL: a member changed a job';
  exception when insufficient_privilege then null;
  end;
end $$;

-- As the worker: nothing to claim while checks are still syncing.
reset role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
set local role service_role;
do $$
declare r record;
begin
  if exists (select 1 from public.claim_forecast_lock_job()) then raise exception 'FAIL: claimed before the checks synced'; end if;
  select * into r from public.forecast_lock_jobs where sampling_event_id = 'aaaaaaaa-0000-4000-8000-00000000f9e1';
  if r.status <> 'waiting_for_sync' or r.next_attempt_at <= now() or r.last_error not like '2 of the 3 stem checks%' then raise exception 'FAIL: waiting %', r; end if;
end $$;

-- The third check syncs; the job becomes due.
reset role;
insert into public.stem_visits (id, organization_id, crop_id, measurement_stem_id, year, week_number, checked, observed_at)
values (gen_random_uuid(), 'aaaaaaaa-0000-4000-8000-00000000f9a0', 'aaaaaaaa-0000-4000-8000-00000000f9c1', 'aaaaaaaa-0000-4000-8000-00000000f923',
        (select y from cw), (select w from cw), true, now());
update public.forecast_lock_jobs set next_attempt_at = now() where sampling_event_id = 'aaaaaaaa-0000-4000-8000-00000000f9e1';
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
set local role service_role;

do $$
declare
  j record;
  r record;
  y integer := (select cw.y from cw);
  w integer := (select cw.w from cw);
begin
  select * into j from public.claim_forecast_lock_job();
  if j.status <> 'running' or j.attempts <> 1 or j.lease_until <= now() then raise exception 'FAIL: claim %', j; end if;
  -- Leased: a second worker gets nothing.
  if exists (select 1 from public.claim_forecast_lock_job()) then raise exception 'FAIL: claimed twice'; end if;

  -- A failure retries later.
  perform public.fail_forecast_lock_job(j.id, 'network error');
  select * into r from public.forecast_lock_jobs where id = j.id;
  if r.status <> 'retry' or r.next_attempt_at <= now() or r.last_error <> 'network error' then raise exception 'FAIL: retry %', r; end if;
end $$;

-- (Test only: fast-forward the retry, as the owner.)
reset role;
update public.forecast_lock_jobs set next_attempt_at = now() where sampling_event_id = 'aaaaaaaa-0000-4000-8000-00000000f9e1';
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
set local role service_role;

do $$
declare
  j record;
  r record;
  y integer := (select cw.y from cw);
  w integer := (select cw.w from cw);
begin
  select * into j from public.claim_forecast_lock_job();
  if j.attempts <> 2 then raise exception 'FAIL: second attempt %', j; end if;

  -- The worker stores the forecast (as the service role) and finishes the job.
  select * into r from public.lock_forecast_run('aaaaaaaa-0000-4000-8000-00000000f9f1', 'aaaaaaaa-0000-4000-8000-00000000f9c1', y, w,
    'aaaaaaaa-0000-4000-8000-00000000f9e1', now(), 1, 1, 'engine-test', 'experimental', '{}', '{}'::jsonb, '{}'::jsonb, 1,
    array['aaaaaaaa-0000-4000-8000-00000000f921'::uuid], 700, '{"sample_fruit": 1, "crop_fruit": 700, "kg": 140}'::jsonb,
    jsonb_build_array(jsonb_build_object('horizon', 1, 'target_year', extract(isoyear from to_date(y || '-' || lpad(w::text, 2, '0'), 'IYYY-IW') + 7)::integer,
      'target_week', extract(week from to_date(y || '-' || lpad(w::text, 2, '0'), 'IYYY-IW') + 7)::integer, 'window', 'marketing',
      'sample_fruit', 1, 'sample_variance', 1, 'crop_fruit', 700, 'expected_aborted', 0, 'expected_pruned', 0, 'kg', 140)), 'lifecycle', null, null, 1);
  if r.kind <> 'official' or not r.stored_now then raise exception 'FAIL: worker lock %', r; end if;
  perform public.finish_forecast_lock_job(j.id, r.run_id);
  select * into r from public.forecast_lock_jobs where id = j.id;
  if r.status <> 'done' or r.run_kind <> 'official' then raise exception 'FAIL: finished %', r; end if;
end $$;

-- Reopened and completed again: the new completion's job finds the week locked and stores nothing.
reset role;
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-4000-8000-00000000f901","role":"authenticated"}', true);
set local role authenticated;
insert into public.sampling_week_events (id, organization_id, crop_id, year, week_number, event, recorded_at) values
  ('aaaaaaaa-0000-4000-8000-00000000f9e2', 'aaaaaaaa-0000-4000-8000-00000000f9a0', 'aaaaaaaa-0000-4000-8000-00000000f9c1', (select y from cw), (select w from cw), 'reopened', now() + interval '1 second'),
  ('aaaaaaaa-0000-4000-8000-00000000f9e3', 'aaaaaaaa-0000-4000-8000-00000000f9a0', 'aaaaaaaa-0000-4000-8000-00000000f9c1', (select y from cw), (select w from cw), 'completed', now() + interval '2 seconds');
reset role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
set local role service_role;
do $$
declare r record;
begin
  if exists (select 1 from public.claim_forecast_lock_job()) then raise exception 'FAIL: claimed a job for a locked week'; end if;
  select * into r from public.forecast_lock_jobs where sampling_event_id = 'aaaaaaaa-0000-4000-8000-00000000f9e3';
  if r.status <> 'done' or r.run_id <> 'aaaaaaaa-0000-4000-8000-00000000f9f1' then raise exception 'FAIL: job of a locked week %', r; end if;
  if (select count(*) from public.forecast_runs where crop_id = 'aaaaaaaa-0000-4000-8000-00000000f9c1') <> 1 then raise exception 'FAIL: a second forecast'; end if;
end $$;

-- A superseded completion (reopened before any lock) is marked so.
reset role;
insert into public.sampling_week_events (id, organization_id, crop_id, year, week_number, event, recorded_at) values
  ('aaaaaaaa-0000-4000-8000-00000000f9e4', 'aaaaaaaa-0000-4000-8000-00000000f9a0', 'aaaaaaaa-0000-4000-8000-00000000f9c1', 2026, 10, 'completed', now() - interval '1 hour'),
  ('aaaaaaaa-0000-4000-8000-00000000f9e5', 'aaaaaaaa-0000-4000-8000-00000000f9a0', 'aaaaaaaa-0000-4000-8000-00000000f9c1', 2026, 10, 'reopened', now());
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
set local role service_role;
do $$
begin
  perform public.claim_forecast_lock_job();
  if (select status from public.forecast_lock_jobs where sampling_event_id = 'aaaaaaaa-0000-4000-8000-00000000f9e4') <> 'superseded' then
    raise exception 'FAIL: superseded completion';
  end if;
end $$;

reset role;
select 'forecast_lock_jobs tests passed' as result;
rollback;
