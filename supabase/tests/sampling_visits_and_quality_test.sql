-- stem_visits, sampling_week_events, data_quality_reviews, crop_stem_weeks(),
-- sampling_weeks() and crop_quality_flags(): visit evidence, coverage,
-- completion, every flag rule, reviews, as-of cutoffs, RLS and append-only.
--
-- Runs inside a transaction that is always rolled back.
-- Prints {"result": "sampling_visits_and_quality tests passed"} on success.

begin;

-- ── Fixture ──────────────────────────────────────────────────────────────────
-- Org A: one crop, 700 picking stems on 100 m² (7 stems/m²), ten sampled stems
-- S01 … S10 in one row. All times are Tuesdays at noon (Toronto).
--
--   W03  S02: node N_STALE recorded SetFruit and never updated
--   W10  every stem visited (legacy: status changes only)
--   W11  S10 has no record (9 of 10: missed_stem_visit)
--   W12  only S01–S03 have records (3 of 10: incomplete_visit); 12 nodes
--        on S01–S03 turn BreakerFruit
--   W13  explicit tracking starts: all ten stems checked, nothing harvested
--        (harvest_not_recorded); marked complete
--   W14  S01 checked then retracted, S02–S10 checked; 8 of the 8 visible
--        breakers harvested (S02–S03); marked complete, then reopened
--   W15  nothing yet; W16 is the current week (as of 2026-04-15)
insert into auth.users (id, email, aud, role) values
  ('aaaaaaaa-0000-4000-8000-00000000d001', 'svq-test-a@example.invalid', 'authenticated', 'authenticated'),
  ('bbbbbbbb-0000-4000-8000-00000000d001', 'svq-test-b@example.invalid', 'authenticated', 'authenticated');
insert into public.organizations (id, name) values
  ('aaaaaaaa-0000-4000-8000-00000000d0a0', 'SVQ Org A'),
  ('bbbbbbbb-0000-4000-8000-00000000d0b0', 'SVQ Org B');
insert into public.organization_members (organization_id, user_id, role) values
  ('aaaaaaaa-0000-4000-8000-00000000d0a0', 'aaaaaaaa-0000-4000-8000-00000000d001', 'owner'),
  ('bbbbbbbb-0000-4000-8000-00000000d0b0', 'bbbbbbbb-0000-4000-8000-00000000d001', 'owner');
insert into public.crops (id, organization_id, name, color, planting_date, pullout_date, area_m2, picking_stems, pepper_type_id) values
  ('aaaaaaaa-0000-4000-8000-00000000dc01', 'aaaaaaaa-0000-4000-8000-00000000d0a0', 'Crop A', 'red', '2025-12-01', '2026-12-01', 100, 700, (select t.id from public.pepper_types t where t.organization_id = 'aaaaaaaa-0000-4000-8000-00000000d0a0' and t.key = 'bell'));
insert into public.measurement_rows (id, organization_id, crop_id, row_name) values
  ('aaaaaaaa-0000-4000-8000-00000000d101', 'aaaaaaaa-0000-4000-8000-00000000d0a0', 'aaaaaaaa-0000-4000-8000-00000000dc01', 'Row A');
insert into public.measurement_stems (id, organization_id, crop_id, measurement_row_id, stem_name, sort_order)
select ('aaaaaaaa-0000-4000-8000-00000000d2' || lpad(s::text, 2, '0'))::uuid, 'aaaaaaaa-0000-4000-8000-00000000d0a0',
       'aaaaaaaa-0000-4000-8000-00000000dc01', 'aaaaaaaa-0000-4000-8000-00000000d101', 'S' || lpad(s::text, 2, '0'), s
from generate_series(1, 10) s;

-- Week w of 2026, Tuesday noon Toronto.
create function pg_temp.at(w integer) returns timestamptz language sql immutable as
  $$ select (to_date('2026-' || lpad(w::text, 2, '0'), 'IYYY-IW') + 1 + time '12:00') at time zone 'America/Toronto' $$;

-- Nodes: one "visit marker" node per stem (F<s>), twelve breaker nodes on
-- S01–S03 (B01–B12, four per stem), and the special cases.
insert into public.plant_nodes (id, organization_id, crop_id, measurement_stem_id, node_number, created_at)
select ('aaaaaaaa-0000-4000-8000-00000000d3' || lpad(s::text, 2, '0'))::uuid, 'aaaaaaaa-0000-4000-8000-00000000d0a0'::uuid, 'aaaaaaaa-0000-4000-8000-00000000dc01'::uuid,
       ('aaaaaaaa-0000-4000-8000-00000000d2' || lpad(s::text, 2, '0'))::uuid, 1, pg_temp.at(10)
from generate_series(1, 10) s
union all
select ('aaaaaaaa-0000-4000-8000-00000000d4' || lpad(b::text, 2, '0'))::uuid, 'aaaaaaaa-0000-4000-8000-00000000d0a0', 'aaaaaaaa-0000-4000-8000-00000000dc01',
       ('aaaaaaaa-0000-4000-8000-00000000d2' || lpad(((b - 1) / 4 + 1)::text, 2, '0'))::uuid, 10 + b, pg_temp.at(10)
from generate_series(1, 12) b
union all
select id::uuid, 'aaaaaaaa-0000-4000-8000-00000000d0a0', 'aaaaaaaa-0000-4000-8000-00000000dc01', stem::uuid, num, pg_temp.at(cw)
from (values
  ('aaaaaaaa-0000-4000-8000-00000000d501', 'aaaaaaaa-0000-4000-8000-00000000d202', 30, 3),   -- N_STALE: SetFruit since W03
  ('aaaaaaaa-0000-4000-8000-00000000d502', 'aaaaaaaa-0000-4000-8000-00000000d204', 31, 10),  -- N_BACK: MatureGreen W10 → SetFruit W11
  ('aaaaaaaa-0000-4000-8000-00000000d503', 'aaaaaaaa-0000-4000-8000-00000000d205', 32, 10)   -- N_SKIP: SetFruit W10 → Harvested W13
) as v(id, stem, num, cw);

-- recorded_at = observed_at: each record reached the database when it was made.
insert into public.node_observations (organization_id, crop_id, plant_node_id, year, week_number, status, observed_at, recorded_at)
select 'aaaaaaaa-0000-4000-8000-00000000d0a0'::uuid, 'aaaaaaaa-0000-4000-8000-00000000dc01'::uuid, n::uuid, 2026, w, st, pg_temp.at(w), pg_temp.at(w)
from (
  -- Visit markers: W10 every stem, W11 all but S10, W12 S01–S03 (Flower, a new record each week).
  select 'aaaaaaaa-0000-4000-8000-00000000d3' || lpad(s::text, 2, '0') as n, w, 'Flower' as st
  from generate_series(1, 10) s, generate_series(10, 12) w
  where (w = 10) or (w = 11 and s <= 9) or (w = 12 and s <= 3)
  union all
  -- B01–B12: SetFruit W10, BreakerFruit W12, B05–B12 (S02–S03) Harvested W14.
  select 'aaaaaaaa-0000-4000-8000-00000000d4' || lpad(b::text, 2, '0'), 10, 'SetFruit' from generate_series(1, 12) b
  union all
  select 'aaaaaaaa-0000-4000-8000-00000000d4' || lpad(b::text, 2, '0'), 12, 'BreakerFruit' from generate_series(1, 12) b
  union all
  select 'aaaaaaaa-0000-4000-8000-00000000d4' || lpad(b::text, 2, '0'), 14, 'Harvested' from generate_series(5, 12) b
  union all
  select * from (values
    ('aaaaaaaa-0000-4000-8000-00000000d501', 3, 'SetFruit'),
    ('aaaaaaaa-0000-4000-8000-00000000d502', 10, 'MatureGreen'),
    ('aaaaaaaa-0000-4000-8000-00000000d502', 11, 'SetFruit'),
    ('aaaaaaaa-0000-4000-8000-00000000d503', 10, 'SetFruit'),
    ('aaaaaaaa-0000-4000-8000-00000000d503', 13, 'Harvested')
  ) as x(n, w, st)
) obs(n, w, st);

-- A W12 record on S04 that only reached the database in W16: invisible to an
-- as-of cutoff before then.
insert into public.node_observations (organization_id, crop_id, plant_node_id, year, week_number, status, observed_at, recorded_at)
values ('aaaaaaaa-0000-4000-8000-00000000d0a0', 'aaaaaaaa-0000-4000-8000-00000000dc01', 'aaaaaaaa-0000-4000-8000-00000000d304',
        2026, 12, 'Aborted', pg_temp.at(12), pg_temp.at(16) + interval '6 hours');

-- ── As user A ────────────────────────────────────────────────────────────────
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-4000-8000-00000000d001","role":"authenticated"}', true);

-- Explicit tracking from W13: checks, a retraction, completion events.
insert into public.stem_visits (organization_id, crop_id, measurement_stem_id, year, week_number, checked, observed_at, recorded_at)
select 'aaaaaaaa-0000-4000-8000-00000000d0a0', 'aaaaaaaa-0000-4000-8000-00000000dc01',
       ('aaaaaaaa-0000-4000-8000-00000000d2' || lpad(s::text, 2, '0'))::uuid, 2026, w, true, pg_temp.at(w), pg_temp.at(w)
from generate_series(1, 10) s, generate_series(13, 14) w;
insert into public.stem_visits (organization_id, crop_id, measurement_stem_id, year, week_number, checked, observed_at, recorded_at)
values ('aaaaaaaa-0000-4000-8000-00000000d0a0', 'aaaaaaaa-0000-4000-8000-00000000dc01', 'aaaaaaaa-0000-4000-8000-00000000d201',
        2026, 14, false, pg_temp.at(14) + interval '5 minutes', pg_temp.at(14) + interval '5 minutes');
insert into public.sampling_week_events (organization_id, crop_id, year, week_number, event, observed_at, recorded_at) values
  ('aaaaaaaa-0000-4000-8000-00000000d0a0', 'aaaaaaaa-0000-4000-8000-00000000dc01', 2026, 13, 'completed', pg_temp.at(13) + interval '6 hours', pg_temp.at(13) + interval '6 hours'),
  ('aaaaaaaa-0000-4000-8000-00000000d0a0', 'aaaaaaaa-0000-4000-8000-00000000dc01', 2026, 14, 'completed', pg_temp.at(14) + interval '6 hours', pg_temp.at(14) + interval '6 hours'),
  ('aaaaaaaa-0000-4000-8000-00000000d0a0', 'aaaaaaaa-0000-4000-8000-00000000dc01', 2026, 14, 'reopened',  pg_temp.at(14) + interval '7 hours', pg_temp.at(14) + interval '7 hours');

do $$
declare
  crop constant uuid := 'aaaaaaaa-0000-4000-8000-00000000dc01';
  as_of constant timestamptz := '2026-04-15 12:00-04';  -- W16
  got text;
  want text;
  r record;
begin
  -- ── sampling_weeks ──
  -- week: expected / visited / checked / unvisited / coverage / tracking / state
  want := concat_ws(' | ',
    'W3 1/1/0/0/1.0000/legacy/legacy',          -- N_STALE's stem only
    'W4 1/0/0/1/0.0000/legacy/legacy',          -- no records: no evidence, not a zero
    'W10 10/10/0/0/1.0000/legacy/legacy',
    'W11 10/9/0/1/0.9000/legacy/legacy',
    'W12 10/3/0/7/0.3000/legacy/legacy',        -- S04's late W12 record isn't in by W16 … see below
    'W13 10/10/10/0/1.0000/explicit/complete',
    'W14 10/9/9/1/0.9000/explicit/in_progress',  -- S01 retracted; completed then reopened
    'W15 10/0/0/10/0.0000/explicit/not_started',
    'W16 10/0/0/10/0.0000/explicit/not_started');
  select string_agg(format('W%s %s/%s/%s/%s/%s/%s/%s', iso_week, expected_stems, visited_stems, checked_stems, unvisited_stems,
                           coverage, tracking, state), ' | ' order by iso_week)
    into got
    from public.sampling_weeks(crop, 2026, as_of - interval '1 day')
    where iso_week in (3, 4, 10, 11, 12, 13, 14, 15, 16);
  if got is distinct from want then raise exception E'FAIL: sampling weeks\n got:  %\n want: %', got, want; end if;

  -- Once S04's late record has arrived (W16, Tuesday evening), W12 has 4 stems.
  select visited_stems into r from public.sampling_weeks(crop, 2026, as_of) where iso_week = 12;
  if r.visited_stems <> 4 then raise exception 'FAIL: W12 with the late record: %', r.visited_stems; end if;

  -- visited_m2 = visited ÷ 7 stems/m²; the current week is provisional; completed_at only while complete.
  select * into r from public.sampling_weeks(crop, 2026, as_of) where iso_week = 13;
  if round(r.visited_m2, 9) <> round(10 / 7.0, 9) or r.completed_at is null or r.completion <> 'completed' then raise exception 'FAIL: W13 %', r; end if;
  select * into r from public.sampling_weeks(crop, 2026, as_of) where iso_week = 14;
  if r.completed_at is not null or r.completion <> 'reopened' then raise exception 'FAIL: W14 reopened %', r; end if;
  select * into r from public.sampling_weeks(crop, 2026, as_of) where iso_week = 16;
  if not r.is_provisional or r.visited_m2 is not null or r.coverage <> 0 then raise exception 'FAIL: W16 %', r; end if;
  -- Before W13's completion was recorded, W13 is still in progress.
  select state into r from public.sampling_weeks(crop, 2026, pg_temp.at(13) + interval '1 hour') where iso_week = 13;
  if r.state <> 'in_progress' then raise exception 'FAIL: W13 before completion %', r.state; end if;
  if (select count(*) from public.sampling_weeks(crop, 2026)) <> 53 then raise exception 'FAIL: 2026 has 53 weeks'; end if;

  -- ── crop_stem_weeks ──
  select * into r from public.crop_stem_weeks(crop, as_of)
    where measurement_stem_id = 'aaaaaaaa-0000-4000-8000-00000000d201' and yw = 202614;
  if r.visited or r.checked or r.has_observation then raise exception 'FAIL: S01 W14 retracted %', r; end if;
  select * into r from public.crop_stem_weeks(crop, as_of)
    where measurement_stem_id = 'aaaaaaaa-0000-4000-8000-00000000d210' and yw = 202613;
  if not r.visited or not r.checked or r.has_observation then raise exception 'FAIL: S10 W13 checked, nothing changed %', r; end if;
  select * into r from public.crop_stem_weeks(crop, as_of)
    where measurement_stem_id = 'aaaaaaaa-0000-4000-8000-00000000d205' and yw = 202610;
  if not r.has_new_node or not r.has_observation or r.checked is not null then raise exception 'FAIL: S05 W10 evidence %', r; end if;

  -- ── crop_quality_flags ──
  want := concat_ws(' | ',
    'missed_stem_visit:202611:S10',
    'stage_regression:202611:S04',
    'incomplete_visit:202612:-',
    'harvest_not_recorded:202613:-',
    'harvest_without_ripening:202613:S05',
    'missed_stem_visit:202614:S01',        -- checked, then the check was retracted
    'stale_status:202603:S02');
  select string_agg(format('%s:%s:%s', f.rule_id, f.yw, coalesce(s.stem_name, '-')), ' | '
                    order by case f.rule_id when 'stale_status' then 1 else 0 end, f.yw, f.rule_id)
    into got
    from public.crop_quality_flags(crop, as_of - interval '1 day') f
    left join public.measurement_stems s on s.id = f.measurement_stem_id;
  if got is distinct from want then raise exception E'FAIL: flags\n got:  %\n want: %', got, want; end if;

  -- Evidence: W13 had 12 breakers on visited stems, none recorded harvested,
  -- judged against the cautious default; next week picked 8 of the 8 still
  -- visible (S01 wasn't visited in W14, so its four aren't counted).
  select evidence into r from public.crop_quality_flags(crop, as_of) where rule_id = 'harvest_not_recorded';
  if (r.evidence ->> 'breakers_at_start')::int <> 12 or (r.evidence ->> 'recorded_harvested')::int <> 0
     or r.evidence ->> 'baseline_source' <> 'default' or (r.evidence ->> 'next_week_pick_rate')::numeric <> 1 then
    raise exception 'FAIL: harvest_not_recorded evidence %', r.evidence;
  end if;
  select evidence into r from public.crop_quality_flags(crop, as_of) where rule_id = 'incomplete_visit';
  if jsonb_array_length(r.evidence -> 'unvisited_stems') <> 6 then raise exception 'FAIL: incomplete_visit evidence %', r.evidence; end if;
  select evidence into r from public.crop_quality_flags(crop, as_of) where rule_id = 'stale_status';
  if (r.evidence ->> 'weeks')::int <> 11 or r.evidence ->> 'stem_last_visit' <> '2026-W14' then raise exception 'FAIL: stale evidence %', r.evidence; end if;

  -- An as-of cutoff before W12 sees no W12/W13 flags.
  if exists (select 1 from public.crop_quality_flags(crop, pg_temp.at(12)) where yw >= 202612) then
    raise exception 'FAIL: flags leak past the cutoff';
  end if;
end $$;

-- ── Reviews: the latest decision wins, as of its time; reopening clears it ──
insert into public.data_quality_reviews (organization_id, crop_id, flag_key, rule_id, decision, note, reviewed_at) values
  ('aaaaaaaa-0000-4000-8000-00000000d0a0', 'aaaaaaaa-0000-4000-8000-00000000dc01', 'harvest_not_recorded:202613', 'harvest_not_recorded',
   'legitimate', 'Crew skipped picking this week', '2026-04-10 09:00-04'),
  ('aaaaaaaa-0000-4000-8000-00000000d0a0', 'aaaaaaaa-0000-4000-8000-00000000dc01', 'harvest_not_recorded:202613', 'harvest_not_recorded',
   'recording_error', 'Checked with the crew: they did pick', '2026-04-12 09:00-04'),
  ('aaaaaaaa-0000-4000-8000-00000000d0a0', 'aaaaaaaa-0000-4000-8000-00000000dc01', 'harvest_not_recorded:202613', 'harvest_not_recorded',
   'unreviewed', 'Reopened', '2026-04-14 09:00-04');
do $$
declare
  crop constant uuid := 'aaaaaaaa-0000-4000-8000-00000000dc01';
  d text;
begin
  select review_decision into d from public.crop_quality_flags(crop, '2026-04-11 12:00-04') where flag_key = 'harvest_not_recorded:202613';
  if d is distinct from 'legitimate' then raise exception 'FAIL: review as of 11 Apr %', d; end if;
  select review_decision into d from public.crop_quality_flags(crop, '2026-04-13 12:00-04') where flag_key = 'harvest_not_recorded:202613';
  if d is distinct from 'recording_error' then raise exception 'FAIL: review as of 13 Apr %', d; end if;
  select review_decision into d from public.crop_quality_flags(crop, '2026-04-15 12:00-04') where flag_key = 'harvest_not_recorded:202613';
  if d is not null then raise exception 'FAIL: reopened flag should be unreviewed, got %', d; end if;
end $$;

-- A review can't be recorded in someone else's name.
do $$
begin
  insert into public.data_quality_reviews (organization_id, crop_id, flag_key, rule_id, decision, reviewed_by)
  values ('aaaaaaaa-0000-4000-8000-00000000d0a0', 'aaaaaaaa-0000-4000-8000-00000000dc01', 'x', 'x', 'legitimate',
          'bbbbbbbb-0000-4000-8000-00000000d001');
  raise exception 'FAIL: review recorded in another user''s name';
exception when insufficient_privilege then null;
end $$;

-- Append-only: no updates or deletes.
do $$
begin
  update public.stem_visits set checked = false;
  raise exception 'FAIL: stem_visits can be updated';
exception when insufficient_privilege then null;
end $$;
do $$
begin
  delete from public.sampling_week_events;
  raise exception 'FAIL: sampling_week_events can be deleted';
exception when insufficient_privilege then null;
end $$;
do $$
begin
  update public.data_quality_reviews set decision = 'legitimate';
  raise exception 'FAIL: data_quality_reviews can be updated';
exception when insufficient_privilege then null;
end $$;

-- ── As user B (another organization) ─────────────────────────────────────────
select set_config('request.jwt.claims', '{"sub":"bbbbbbbb-0000-4000-8000-00000000d001","role":"authenticated"}', true);
do $$
begin
  if exists (select 1 from public.sampling_weeks('aaaaaaaa-0000-4000-8000-00000000dc01', 2026))
     or exists (select 1 from public.crop_quality_flags('aaaaaaaa-0000-4000-8000-00000000dc01'))
     or exists (select 1 from public.crop_stem_weeks('aaaaaaaa-0000-4000-8000-00000000dc01'))
     or exists (select 1 from public.stem_visits)
     or exists (select 1 from public.sampling_week_events)
     or exists (select 1 from public.data_quality_reviews) then
    raise exception 'FAIL: B sees A''s sampling data';
  end if;
end $$;
do $$
begin
  insert into public.sampling_week_events (organization_id, crop_id, year, week_number, event)
  values ('aaaaaaaa-0000-4000-8000-00000000d0a0', 'aaaaaaaa-0000-4000-8000-00000000dc01', 2026, 15, 'completed');
  raise exception 'FAIL: B completed A''s week';
exception when insufficient_privilege then null;
end $$;

-- ── anon can't call or read ───────────────────────────────────────────────────
reset role;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
set local role anon;
do $$
begin
  perform public.crop_quality_flags('aaaaaaaa-0000-4000-8000-00000000dc01');
  raise exception 'FAIL: anon can call crop_quality_flags';
exception when insufficient_privilege then null;
end $$;
do $$
begin
  perform 1 from public.stem_visits;
  raise exception 'FAIL: anon can read stem_visits';
exception when insufficient_privilege then null;
end $$;

reset role;
select 'sampling_visits_and_quality tests passed' as result;
rollback;
