-- node_attention_rules: seeded defaults incl. "No status yet" (existing and new organizations),
-- members read, owners change, organization isolation, validation, no deletes.
--
-- Runs inside a transaction that is always rolled back, so it leaves nothing
-- behind. Any failed expectation raises and aborts the script.
--
--   npx supabase db query --linked -f supabase/tests/node_attention_rules_test.sql
--
-- Prints a single row {"result": "node_attention_rules tests passed"} on success.

begin;

-- Every existing organization has the four default rules.
do $$
begin
  if exists (
    select 1 from public.organizations o
    where (select count(*) from public.node_attention_rules r where r.organization_id = o.id) <> 5
  ) then raise exception 'FAIL: an organization is missing its default rules'; end if;
end $$;

insert into auth.users (id, email, aud, role) values
  ('c0000000-0000-4000-8000-0000000000a1', 'rules-owner-a@example.invalid', 'authenticated', 'authenticated'),
  ('c0000000-0000-4000-8000-0000000000a2', 'rules-member-a@example.invalid', 'authenticated', 'authenticated'),
  ('c0000000-0000-4000-8000-0000000000b1', 'rules-owner-b@example.invalid', 'authenticated', 'authenticated');

-- A new organization (created the way the app does it) gets the defaults.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"c0000000-0000-4000-8000-0000000000a1","role":"authenticated"}', true);
create temporary table org_a on commit drop as select id from public.create_organization('Rules Org A');
select set_config('request.jwt.claims', '{"sub":"c0000000-0000-4000-8000-0000000000b1","role":"authenticated"}', true);
create temporary table org_b on commit drop as select id from public.create_organization('Rules Org B');
reset role;
insert into public.organization_members (organization_id, user_id, role)
select id, 'c0000000-0000-4000-8000-0000000000a2', 'member' from org_a;
grant select on org_a, org_b to authenticated;

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"c0000000-0000-4000-8000-0000000000a1","role":"authenticated"}', true);
do $$
declare got text;
begin
  select string_agg(rule_key || '=' || max_days, ',' order by rule_key) into got from public.node_attention_rules where organization_id = (select id from org_a);
  if got is distinct from 'BreakerFruit=14,Flower=7,MatureGreen=49,NoStatus=7,SetFruit=14' then raise exception 'FAIL: new organization defaults %', got; end if;

  -- The owner changes a rule (as Settings does: upsert).
  insert into public.node_attention_rules (organization_id, rule_key, max_days) values ((select id from org_a), 'SetFruit', 10)
    on conflict (organization_id, rule_key) do update set max_days = excluded.max_days;
  if (select max_days from public.node_attention_rules where organization_id = (select id from org_a) and rule_key = 'SetFruit') <> 10 then raise exception 'FAIL: owner update'; end if;
  if (select updated_by from public.node_attention_rules where organization_id = (select id from org_a) and rule_key = 'SetFruit') is distinct from 'c0000000-0000-4000-8000-0000000000a1' then
    raise exception 'FAIL: updated_by not stamped with the signed-in owner';
  end if;

  begin
    update public.node_attention_rules set max_days = 0 where organization_id = (select id from org_a) and rule_key = 'Flower';
    raise exception 'FAIL: 0 days accepted';
  exception when check_violation then null;
  end;
  begin
    update public.node_attention_rules set max_days = 366 where organization_id = (select id from org_a) and rule_key = 'Flower';
    raise exception 'FAIL: 366 days accepted';
  exception when check_violation then null;
  end;
  begin
    insert into public.node_attention_rules (organization_id, rule_key, max_days) values ((select id from org_a), 'Ripe', 5);
    raise exception 'FAIL: unknown rule key accepted';
  exception when check_violation then null;
  end;
  -- "No status yet" is configurable like the others.
  update public.node_attention_rules set max_days = 3 where organization_id = (select id from org_a) and rule_key = 'NoStatus';
  if (select max_days from public.node_attention_rules where organization_id = (select id from org_a) and rule_key = 'NoStatus') <> 3 then raise exception 'FAIL: NoStatus update'; end if;
  begin
    update public.node_attention_rules set max_days = 0 where organization_id = (select id from org_a) and rule_key = 'NoStatus';
    raise exception 'FAIL: NoStatus 0 days accepted';
  exception when check_violation then null;
  end;
  -- It is not a node status.
  begin
    insert into public.node_observations (organization_id, crop_id, plant_node_id, year, week_number, status, observed_at)
    values ((select id from org_a), gen_random_uuid(), gen_random_uuid(), 2026, 40, 'NoStatus', now());
    raise exception 'FAIL: NoStatus accepted as an observation status';
  exception when check_violation then null;
  end;
  begin
    delete from public.node_attention_rules where organization_id = (select id from org_a);
    raise exception 'FAIL: delete allowed';
  exception when insufficient_privilege then null;
  end;

  -- Another organization's rules are invisible and unchangeable.
  if exists (select 1 from public.node_attention_rules where organization_id = (select id from org_b)) then raise exception 'FAIL: A sees B''s rules'; end if;
  update public.node_attention_rules set max_days = 1 where organization_id = (select id from org_b);
  begin
    insert into public.node_attention_rules (organization_id, rule_key, max_days) values ((select id from org_b), 'Harvested', 3);
    raise exception 'FAIL: A wrote B''s rules';
  exception when insufficient_privilege then null;
  end;
end $$;

-- A member (not owner) can read but not change them.
select set_config('request.jwt.claims', '{"sub":"c0000000-0000-4000-8000-0000000000a2","role":"authenticated"}', true);
do $$
begin
  if (select count(*) from public.node_attention_rules where organization_id = (select id from org_a)) <> 5 then raise exception 'FAIL: member cannot read rules'; end if;
  update public.node_attention_rules set max_days = 1 where organization_id = (select id from org_a);
  begin
    insert into public.node_attention_rules (organization_id, rule_key, max_days) values ((select id from org_a), 'Harvested', 3);
    raise exception 'FAIL: member added a rule';
  exception when insufficient_privilege then null;
  end;
end $$;

reset role;
do $$
begin
  if (select max_days from public.node_attention_rules where organization_id = (select id from org_a) and rule_key = 'Flower') <> 7 then raise exception 'FAIL: member changed a rule'; end if;
  if (select max_days from public.node_attention_rules where organization_id = (select id from org_b) and rule_key = 'Flower') <> 7 then raise exception 'FAIL: A changed B''s rule'; end if;
end $$;

-- anon sees nothing.
select set_config('request.jwt.claims', '{"role":"anon"}', true);
set local role anon;
do $$
begin
  perform count(*) from public.node_attention_rules;
  raise exception 'FAIL: anon can read rules';
exception when insufficient_privilege then null;
end $$;

reset role;
select 'node_attention_rules tests passed' as result;
rollback;
