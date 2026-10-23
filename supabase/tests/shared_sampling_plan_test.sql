-- 20261106000000_shared_sampling_plan: one sampling plan for every coverage figure.
--
-- Runs inside a transaction that is always rolled back.
-- Prints {"result": "shared_sampling_plan tests passed"} on success.

begin;

-- ── Fixture ──────────────────────────────────────────────────────────────────
-- Crop P: Row 1 (S1–S4), Row 2 (S5), Row 9 (inactive: S9).
--   S1  created W40, visited W40–W42.
--   S2  created W40, never visited (a sampling position with nothing recorded).
--   S3  created W42, visited W42: not expected before W42.
--   S4  created W44 (imported later), but records from W41: expected from W41.
--   S5  inactive stem, visited W40: never expected.
--   S9  active stem in an inactive row, visited W40: never expected.
insert into auth.users (id, email, aud, role) values
  ('dddddddd-0000-4000-8000-00000000d001', 'sp@example.invalid', 'authenticated', 'authenticated');
insert into public.organizations (id, name) values ('dddddddd-0000-4000-8000-00000000d0a0', 'SP Org');
insert into public.organization_members (organization_id, user_id, role) values
  ('dddddddd-0000-4000-8000-00000000d0a0', 'dddddddd-0000-4000-8000-00000000d001', 'owner');
insert into public.crops (id, organization_id, name, color, planting_date, pullout_date, area_m2, picking_stems, pepper_type_id) values
  ('dddddddd-0000-4000-8000-00000000dc01', 'dddddddd-0000-4000-8000-00000000d0a0', 'Crop P', 'red', '2026-01-05', '2026-12-31', 100, 700, (select t.id from public.pepper_types t where t.organization_id = 'dddddddd-0000-4000-8000-00000000d0a0' and t.key = 'bell'));

-- Friday of week w, 2026, at noon Toronto.
create function pg_temp.fri(w integer) returns timestamptz language sql immutable as
  $$ select (to_date('2026-' || lpad(w::text, 2, '0'), 'IYYY-IW') + 4 + time '12:00') at time zone 'America/Toronto' $$;
create function pg_temp.id(s text) returns uuid language sql immutable as $$ select ('dddddddd-0000-4000-8000-0000000' || s)::uuid $$;

insert into public.measurement_rows (id, organization_id, crop_id, row_name, sort_order, is_active) values
  (pg_temp.id('0d101'), 'dddddddd-0000-4000-8000-00000000d0a0', 'dddddddd-0000-4000-8000-00000000dc01', 'Row 1', 1, true),
  (pg_temp.id('0d102'), 'dddddddd-0000-4000-8000-00000000d0a0', 'dddddddd-0000-4000-8000-00000000dc01', 'Row 2', 2, true),
  (pg_temp.id('0d109'), 'dddddddd-0000-4000-8000-00000000d0a0', 'dddddddd-0000-4000-8000-00000000dc01', 'Row 9', 9, false);
insert into public.measurement_stems (id, organization_id, crop_id, measurement_row_id, stem_name, sort_order, is_active, created_at)
select pg_temp.id(s), 'dddddddd-0000-4000-8000-00000000d0a0', 'dddddddd-0000-4000-8000-00000000dc01', pg_temp.id(r), name, ord, active, pg_temp.fri(w) - interval '2 days'
from (values
  ('0d201', '0d101', 'S1', 1, true, 40),
  ('0d202', '0d101', 'S2', 2, true, 40),
  ('0d203', '0d101', 'S3', 3, true, 42),
  ('0d204', '0d101', 'S4', 4, true, 44),
  ('0d205', '0d102', 'S5', 1, false, 40),
  ('0d209', '0d109', 'S9', 1, true, 40)
) x(s, r, name, ord, active, w);

-- One node per visited stem, with a status record in each visited week.
insert into public.plant_nodes (id, organization_id, crop_id, measurement_stem_id, node_number, created_at)
select pg_temp.id(n), 'dddddddd-0000-4000-8000-00000000d0a0', 'dddddddd-0000-4000-8000-00000000dc01', pg_temp.id(s), 1, pg_temp.fri(w)
from (values ('0d301', '0d201', 40), ('0d303', '0d203', 42), ('0d304', '0d204', 41), ('0d305', '0d205', 40), ('0d309', '0d209', 40)) x(n, s, w);
insert into public.node_observations (organization_id, crop_id, plant_node_id, year, week_number, status, observed_at, recorded_at)
select 'dddddddd-0000-4000-8000-00000000d0a0', 'dddddddd-0000-4000-8000-00000000dc01', pg_temp.id(n), 2026, w, st, pg_temp.fri(w), pg_temp.fri(w)
from (values
  ('0d301', 40, 'Flower'), ('0d301', 41, 'SetFruit'), ('0d301', 42, 'SetFruit'),
  ('0d303', 42, 'SetFruit'),
  ('0d304', 41, 'Flower'), ('0d304', 42, 'SetFruit'),
  ('0d305', 40, 'Flower'), ('0d309', 40, 'Flower')
) x(n, w, st);

-- ── stem_sampling_plan ───────────────────────────────────────────────────────
do $$
declare got text;
begin
  select string_agg(s.stem_name || ':' || (p.start_yw % 100) || coalesce('-' || (p.end_yw % 100), ''), ' ' order by s.stem_name) into got
  from public.stem_sampling_plan('dddddddd-0000-4000-8000-00000000dc01', 'infinity') p
  join public.measurement_stems s on s.id = p.measurement_stem_id;
  -- S2 included with no records; S4 from its records (W41), not its creation (W44); S5 and S9 excluded.
  if got is distinct from 'S1:40 S2:40 S3:42 S4:41' then raise exception 'plan: %', got; end if;

  -- As of Friday W41: S3 and S4 did not exist yet and S4's W41 record was already in, so S4 counts.
  select string_agg(s.stem_name || ':' || (p.start_yw % 100), ' ' order by s.stem_name) into got
  from public.stem_sampling_plan('dddddddd-0000-4000-8000-00000000dc01', pg_temp.fri(41)) p
  join public.measurement_stems s on s.id = p.measurement_stem_id;
  if got is distinct from 'S1:40 S2:40 S4:41' then raise exception 'plan as of W41: %', got; end if;

  -- As of Friday W40: S4's records were not recorded yet and it was created later: not in the plan.
  select string_agg(s.stem_name, ' ' order by s.stem_name) into got
  from public.stem_sampling_plan('dddddddd-0000-4000-8000-00000000dc01', pg_temp.fri(40)) p
  join public.measurement_stems s on s.id = p.measurement_stem_id;
  if got is distinct from 'S1 S2' then raise exception 'plan as of W40: %', got; end if;
end $$;

-- ── sampling_weeks: expected from the plan; visits unchanged ─────────────────
do $$
declare got text;
begin
  select string_agg(format('%s:%s/%s', iso_week, visited_stems, expected_stems), ' ' order by iso_week) into got
  from public.sampling_weeks('dddddddd-0000-4000-8000-00000000dc01', 2026, pg_temp.fri(45))
  where iso_week between 39 and 45;
  -- W40: S1 of S1, S2 (S5 and S9 visited but outside the plan, as before: visits come from crop_stem_weeks).
  if got is distinct from '39:0/0 40:1/2 41:2/3 42:3/4 43:0/4 44:0/4 45:0/4' then raise exception 'sampling_weeks: %', got; end if;
end $$;

-- ── weekly_variety_metrics: expected_stems from the plan, counts unchanged ──
do $$
declare got text;
begin
  select string_agg(format('%s:%s/%s set %s', m.yw % 100, m.stems, m.expected_stems, m.set_fruit), ' ' order by m.yw) into got
  from public.weekly_variety_metrics('dddddddd-0000-4000-8000-00000000d0a0') m;
  if got is distinct from '40:1/2 set 0 41:2/3 set 1 42:3/4 set 3' then raise exception 'weekly_variety_metrics: %', got; end if;
end $$;

-- ── crop_quality_flags_all: never-visited stems count as unvisited ──────────
do $$
declare got text;
begin
  select string_agg(f.title || ' ' || (f.evidence -> 'unvisited_stems')::text, ' | ' order by f.yw) into got
  from (select * from public.crop_quality_flags_all('dddddddd-0000-4000-8000-00000000dc01', pg_temp.fri(43)) where rule_id = 'incomplete_visit') f;
  if got not like 'Incomplete visit: 1 of 2 stems %"S2"%| Incomplete visit: 2 of 3 stems %"S2"%| Incomplete visit: 3 of 4 stems %"S2"%' then
    raise exception 'incomplete_visit: %', got;
  end if;
end $$;

-- ── The collector and the forecast lock count the same stems as the plan ──
-- forecast_lock_readiness counts active stems of active rows created by the completion.
-- S9 (inactive row) is in neither, and its W40 visit counts nowhere (crop_stem_weeks).
do $$
declare plan_n integer; lock_n integer;
begin
  select count(*) into plan_n from public.stem_sampling_plan('dddddddd-0000-4000-8000-00000000dc01', pg_temp.fri(42)) p where p.start_yw <= 202642;
  select count(*) into lock_n from public.measurement_stems s join public.measurement_rows r on r.id = s.measurement_row_id
   where s.crop_id = 'dddddddd-0000-4000-8000-00000000dc01' and s.is_active and r.is_active and s.created_at <= pg_temp.fri(42);
  -- Identical except S4, whose records prove it was sampled before it was created (imported history).
  if lock_n <> 3 or plan_n <> lock_n + 1 then raise exception 'plan % vs lock %', plan_n, lock_n; end if;
  select count(*) into plan_n from public.stem_sampling_plan('dddddddd-0000-4000-8000-00000000dc01', pg_temp.fri(42)) p
   join public.measurement_stems s on s.id = p.measurement_stem_id where p.start_yw <= 202642 and s.created_at <= pg_temp.fri(42);
  if plan_n <> lock_n then raise exception 'stems created by then: plan % vs lock %', plan_n, lock_n; end if;
end $$;

-- ── Access: members only (RLS through security invoker) ─────────────────────
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "ffffffff-0000-4000-8000-00000000f999", "role": "authenticated"}', true);
do $$
begin
  if exists (select 1 from public.stem_sampling_plan('dddddddd-0000-4000-8000-00000000dc01', 'infinity')) then
    raise exception 'a non-member sees the plan';
  end if;
end $$;
select set_config('request.jwt.claims', '{"sub": "dddddddd-0000-4000-8000-00000000d001", "role": "authenticated"}', true);
do $$
begin
  if (select count(*) from public.stem_sampling_plan('dddddddd-0000-4000-8000-00000000dc01', 'infinity')) <> 4 then
    raise exception 'the member does not see the plan';
  end if;
end $$;
reset role;
set local role anon;
do $$
begin
  perform public.stem_sampling_plan('dddddddd-0000-4000-8000-00000000dc01', 'infinity');
  raise exception 'anon can call stem_sampling_plan';
exception when insufficient_privilege then null;
end $$;
reset role;

select '{"result": "shared_sampling_plan tests passed"}' as result;
rollback;
