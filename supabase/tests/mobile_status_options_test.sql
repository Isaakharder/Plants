-- mobile_status_options: defaults (existing and new organizations offer all
-- seven statuses), owner-only changes, member reads, organization isolation,
-- never zero statuses, no deletes, and no effect on observations or on any
-- desktop calculation.
--
-- Runs inside a transaction that is always rolled back.
--   npx supabase db query --linked -f supabase/tests/mobile_status_options_test.sql
-- Prints {"result": "mobile_status_options tests passed"} on success.

begin;

-- ── Existing organizations: all seven, all enabled ───────────────────────────
do $$
begin
  if exists (
    select 1 from public.organizations o
    where (select count(*) from public.mobile_status_options m where m.organization_id = o.id and m.enabled) <> 7
  ) then raise exception 'FAIL: an existing organization does not offer all seven statuses'; end if;
end $$;

-- Desktop results and observations before anything changes.
create temporary table calc_before as
  select c.id, 'weekly' as fn, to_jsonb(w) as r from public.crops c cross join lateral public.weekly_plant_data(c.id, 2026, '2026-10-05') w
  union all
  select c.id, 'cohorts', to_jsonb(h) from public.crops c cross join lateral public.set_harvest_cohorts(c.id, 2026, '2026-10-05') h
  union all
  select c.id, 'fruit_loss', to_jsonb(f) from public.crops c cross join lateral public.weekly_fruit_loss(c.id, 2026, '2026-10-05') f;
create temporary table obs_before as select * from public.node_observations;
grant select on calc_before, obs_before to authenticated;

-- ── Fixture: org A (owner + member), org B (owner) ──────────────────────────
insert into auth.users (id, email, aud, role) values
  ('aaaaaaaa-0000-4000-8000-00000005a001', 'mso-owner-a@example.invalid', 'authenticated', 'authenticated'),
  ('aaaaaaaa-0000-4000-8000-00000005a002', 'mso-member-a@example.invalid', 'authenticated', 'authenticated'),
  ('bbbbbbbb-0000-4000-8000-00000005b001', 'mso-owner-b@example.invalid', 'authenticated', 'authenticated');
insert into public.organizations (id, name) values
  ('aaaaaaaa-0000-4000-8000-00000005a0a0', 'MSO Org A'),
  ('bbbbbbbb-0000-4000-8000-00000005b0b0', 'MSO Org B');
insert into public.organization_members (organization_id, user_id, role) values
  ('aaaaaaaa-0000-4000-8000-00000005a0a0', 'aaaaaaaa-0000-4000-8000-00000005a001', 'owner'),
  ('aaaaaaaa-0000-4000-8000-00000005a0a0', 'aaaaaaaa-0000-4000-8000-00000005a002', 'member'),
  ('bbbbbbbb-0000-4000-8000-00000005b0b0', 'bbbbbbbb-0000-4000-8000-00000005b001', 'owner');

-- A new organization is seeded with all seven enabled.
do $$
begin
  if (select array_agg(status order by status) from public.mobile_status_options
      where organization_id = 'aaaaaaaa-0000-4000-8000-00000005a0a0' and enabled)
     <> array['Aborted', 'BreakerFruit', 'Flower', 'Harvested', 'MatureGreen', 'Pruned', 'SetFruit'] then
    raise exception 'FAIL: new organization not seeded with all seven';
  end if;
end $$;

-- ── Owner A ──────────────────────────────────────────────────────────────────
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-4000-8000-00000005a001","role":"authenticated"}', true);
do $$
declare n integer;
begin
  -- Save as Settings does: one upsert of all seven. Flower and Mature Green off.
  insert into public.mobile_status_options (organization_id, status, enabled)
  select 'aaaaaaaa-0000-4000-8000-00000005a0a0', s, s not in ('Flower', 'MatureGreen')
  from unnest(array['Aborted', 'Pruned', 'Flower', 'SetFruit', 'MatureGreen', 'BreakerFruit', 'Harvested']) s
  on conflict (organization_id, status) do update set enabled = excluded.enabled;
  set constraints public.mobile_status_options_keep_one immediate;
  set constraints public.mobile_status_options_keep_one deferred;
  if (select array_agg(status order by status) from public.mobile_status_options
      where organization_id = 'aaaaaaaa-0000-4000-8000-00000005a0a0' and enabled)
     <> array['Aborted', 'BreakerFruit', 'Harvested', 'Pruned', 'SetFruit'] then
    raise exception 'FAIL: owner save';
  end if;
  if (select updated_by from public.mobile_status_options where organization_id = 'aaaaaaaa-0000-4000-8000-00000005a0a0' and status = 'Flower')
     <> 'aaaaaaaa-0000-4000-8000-00000005a001' then raise exception 'FAIL: updated_by not stamped'; end if;

  -- Zero statuses is refused (checked at commit; forced here).
  begin
    update public.mobile_status_options set enabled = false where organization_id = 'aaaaaaaa-0000-4000-8000-00000005a0a0';
    set constraints public.mobile_status_options_keep_one immediate;
    raise exception 'FAIL: zero statuses accepted';
  exception when check_violation then null;
  end;
  set constraints public.mobile_status_options_keep_one deferred;
  -- Switching the only enabled status for another in one save is fine, in either order.
  update public.mobile_status_options set enabled = (status = 'Harvested') where organization_id = 'aaaaaaaa-0000-4000-8000-00000005a0a0';
  update public.mobile_status_options set enabled = (status = 'Aborted') where organization_id = 'aaaaaaaa-0000-4000-8000-00000005a0a0';
  set constraints public.mobile_status_options_keep_one immediate;
  set constraints public.mobile_status_options_keep_one deferred;
  -- Back to our choice for the remaining checks.
  update public.mobile_status_options set enabled = status not in ('Flower', 'MatureGreen') where organization_id = 'aaaaaaaa-0000-4000-8000-00000005a0a0';

  -- No deletes (not granted at all).
  begin
    delete from public.mobile_status_options where organization_id = 'aaaaaaaa-0000-4000-8000-00000005a0a0';
    raise exception 'FAIL: owner could delete';
  exception when insufficient_privilege then null;
  end;

  -- Org B's options are invisible and unchangeable.
  if exists (select 1 from public.mobile_status_options where organization_id = 'bbbbbbbb-0000-4000-8000-00000005b0b0') then raise exception 'FAIL: A reads B'; end if;
  update public.mobile_status_options set enabled = false where organization_id = 'bbbbbbbb-0000-4000-8000-00000005b0b0' and status = 'Flower';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL: A changed B'; end if;
end $$;

-- ── Member A (not an owner): reads, can't change ────────────────────────────
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-4000-8000-00000005a002","role":"authenticated"}', true);
do $$
declare n integer;
begin
  if (select count(*) from public.mobile_status_options where organization_id = 'aaaaaaaa-0000-4000-8000-00000005a0a0' and enabled) <> 5 then
    raise exception 'FAIL: member can''t read the options';
  end if;
  update public.mobile_status_options set enabled = true where organization_id = 'aaaaaaaa-0000-4000-8000-00000005a0a0';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL: member changed % rows', n; end if;
  begin
    insert into public.mobile_status_options (organization_id, status, enabled) values ('aaaaaaaa-0000-4000-8000-00000005a0a0', 'Flower', true)
      on conflict (organization_id, status) do update set enabled = true;
    raise exception 'FAIL: member upsert accepted';
  exception when insufficient_privilege then null;
  end;
end $$;

-- ── Owner B: sees only B, all seven still enabled ───────────────────────────
select set_config('request.jwt.claims', '{"sub":"bbbbbbbb-0000-4000-8000-00000005b001","role":"authenticated"}', true);
do $$
begin
  if exists (select 1 from public.mobile_status_options where organization_id = 'aaaaaaaa-0000-4000-8000-00000005a0a0') then raise exception 'FAIL: B reads A'; end if;
  if (select count(*) from public.mobile_status_options where organization_id = 'bbbbbbbb-0000-4000-8000-00000005b0b0' and enabled) <> 7 then
    raise exception 'FAIL: B affected by A';
  end if;
end $$;

-- ── anon: nothing ────────────────────────────────────────────────────────────
reset role;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
set local role anon;
do $$
begin
  perform count(*) from public.mobile_status_options;
  raise exception 'FAIL: anon can read mobile status options';
exception when insufficient_privilege then null;
end $$;

-- ── Every existing organization hides Flower + Mature Green: nothing else changes ──
reset role;
update public.mobile_status_options set enabled = status not in ('Flower', 'MatureGreen');
set constraints public.mobile_status_options_keep_one immediate;
do $$
begin
  if exists (
    (select * from calc_before except
      select c.id, 'weekly', to_jsonb(w) from public.crops c cross join lateral public.weekly_plant_data(c.id, 2026, '2026-10-05') w
      except select c.id, 'cohorts', to_jsonb(h) from public.crops c cross join lateral public.set_harvest_cohorts(c.id, 2026, '2026-10-05') h
      except select c.id, 'fruit_loss', to_jsonb(f) from public.crops c cross join lateral public.weekly_fruit_loss(c.id, 2026, '2026-10-05') f)
  ) then raise exception 'FAIL: a desktop calculation changed'; end if;
  if (select count(*) from (
        select c.id, 'weekly', to_jsonb(w) from public.crops c cross join lateral public.weekly_plant_data(c.id, 2026, '2026-10-05') w
        union all select c.id, 'cohorts', to_jsonb(h) from public.crops c cross join lateral public.set_harvest_cohorts(c.id, 2026, '2026-10-05') h
        union all select c.id, 'fruit_loss', to_jsonb(f) from public.crops c cross join lateral public.weekly_fruit_loss(c.id, 2026, '2026-10-05') f) x)
     <> (select count(*) from calc_before) then raise exception 'FAIL: desktop row counts changed'; end if;
  if exists ((select * from obs_before except select * from public.node_observations) union all (select * from public.node_observations except select * from obs_before)) then
    raise exception 'FAIL: observations changed';
  end if;
  -- Flower and Mature Green records still exist and still count.
  if (select count(*) from public.node_observations where status in ('Flower', 'MatureGreen')) <> (select count(*) from obs_before where status in ('Flower', 'MatureGreen')) then
    raise exception 'FAIL: hidden-status observations changed';
  end if;
end $$;

select 'mobile_status_options tests passed' as result;
rollback;
