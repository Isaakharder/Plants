-- Regression: rows loaded with their original ids (a copy or restore) must not
-- make the next AFW save fail with "duplicate key … weekly_harvest_afw_log_pkey".
-- supabase/scripts/sync_identity_sequences.sql moves the counters forward;
-- every AFW change is then logged exactly once.
--
-- Runs inside a transaction that is always rolled back.
-- Prints {"result": "identity_sequences tests passed"} on success.

begin;

insert into auth.users (id, email, aud, role) values
  ('99999999-0000-4000-8000-000000009001', 'seq-test@example.invalid', 'authenticated', 'authenticated');
insert into public.organizations (id, name) values ('99999999-0000-4000-8000-0000000090a0', 'Sequence Org');
insert into public.organization_members (organization_id, user_id, role) values
  ('99999999-0000-4000-8000-0000000090a0', '99999999-0000-4000-8000-000000009001', 'owner');
insert into public.crops (id, organization_id, name, color, planting_date, pullout_date, area_m2, picking_stems, pepper_type_id) values
  ('99999999-0000-4000-8000-0000000090c1', '99999999-0000-4000-8000-0000000090a0', 'Seq Crop', 'red', '2026-01-05', '2026-12-31', 100, 700, (select t.id from public.pepper_types t where t.organization_id = '99999999-0000-4000-8000-0000000090a0' and t.key = 'bell'));

-- A copy loaded with its original ids: AFW history 1–40 and actual kg 1–16, counters untouched
-- (as on a fresh database; counters aren't transactional, so set them explicitly).
select setval('public.weekly_harvest_afw_log_id_seq', 1, false), setval('public.weekly_harvest_actuals_id_seq', 1, false);
set local session_replication_role = replica;
insert into public.weekly_harvest_afw_log (id, organization_id, crop_id, year, week, afw_g, action)
  overriding system value
  select g, '99999999-0000-4000-8000-0000000090a0', '99999999-0000-4000-8000-0000000090c1', 2026, 1 + g % 40, 200, 'baseline' from generate_series(1, 40) g;
insert into public.weekly_harvest_actuals (id, organization_id, crop_id, year, week, actual_kg)
  overriding system value
  select g, '99999999-0000-4000-8000-0000000090a0', '99999999-0000-4000-8000-0000000090c1', 2026, g, 1000 from generate_series(1, 16) g;
set local session_replication_role = origin;

-- Without the fix the next AFW save fails exactly as reported.
do $$
begin
  insert into public.weekly_harvest_afw (organization_id, crop_id, year, week, afw_g)
    values ('99999999-0000-4000-8000-0000000090a0', '99999999-0000-4000-8000-0000000090c1', 2026, 43, 210);
  raise exception 'FAIL: the stale counter did not reproduce the error';
exception when unique_violation then
  if sqlerrm not like '%weekly_harvest_afw_log_pkey%' then raise exception 'FAIL: unexpected error %', sqlerrm; end if;
end $$;

\ir ../scripts/sync_identity_sequences.sql

-- Running it again changes nothing and never lowers a counter.
create temp table counters as select (select last_value from public.weekly_harvest_afw_log_id_seq) afw, (select last_value from public.weekly_harvest_actuals_id_seq) actuals;
\ir ../scripts/sync_identity_sequences.sql
do $$
begin
  if (select afw from counters) <> 40 or (select actuals from counters) <> 16
     or (select last_value from public.weekly_harvest_afw_log_id_seq) <> 40 or (select last_value from public.weekly_harvest_actuals_id_seq) <> 16 then
    raise exception 'FAIL: counters %', (select row(afw, actuals) from counters);
  end if;
end $$;

-- Two AFW changes saved the way the app saves them (one upsert, as a member), then one edited again.
grant select on counters to authenticated;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"99999999-0000-4000-8000-000000009001","role":"authenticated"}', true);
insert into public.weekly_harvest_afw (organization_id, crop_id, year, week, afw_g) values
  ('99999999-0000-4000-8000-0000000090a0', '99999999-0000-4000-8000-0000000090c1', 2026, 43, 210),
  ('99999999-0000-4000-8000-0000000090a0', '99999999-0000-4000-8000-0000000090c1', 2026, 44, 215)
on conflict (crop_id, year, week) do update set afw_g = excluded.afw_g;
insert into public.weekly_harvest_afw (organization_id, crop_id, year, week, afw_g) values
  ('99999999-0000-4000-8000-0000000090a0', '99999999-0000-4000-8000-0000000090c1', 2026, 43, 210),  -- unchanged: not logged again
  ('99999999-0000-4000-8000-0000000090a0', '99999999-0000-4000-8000-0000000090c1', 2026, 44, 220)
on conflict (crop_id, year, week) do update set afw_g = excluded.afw_g;
insert into public.weekly_harvest_actuals (organization_id, crop_id, year, week, actual_kg)
  values ('99999999-0000-4000-8000-0000000090a0', '99999999-0000-4000-8000-0000000090c1', 2026, 43, 900);
do $$
declare got text;
begin
  select string_agg(format('%s:W%s %s %s', id, week, afw_g, action), ' ' order by id) into got
    from public.weekly_harvest_afw_log where id > 40;
  if got <> '41:W43 210.0 set 42:W44 215.0 set 43:W44 220.0 set' then raise exception 'FAIL: log %', got; end if;
  if (select count(*) from public.weekly_harvest_afw_log) <> 43 or (select count(*) from public.weekly_harvest_actuals) <> 17 then raise exception 'FAIL: counts'; end if;
  -- The loaded history is untouched.
  if (select count(*) from public.weekly_harvest_afw_log where id <= 40 and action = 'baseline' and afw_g = 200) <> 40 then raise exception 'FAIL: history changed'; end if;
end $$;
reset role;

select '{"result": "identity_sequences tests passed"}';
rollback;
