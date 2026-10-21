-- 20261102000000_climate_report_thresholds: shared per organization, owners
-- change them, every change kept, defaults until the first change.
--
-- Runs inside a transaction that is always rolled back.
-- Prints {"result": "climate_report_thresholds tests passed"} on success.

begin;

insert into auth.users (id, email, aud, role) values
  ('aaaaaaaa-0000-4000-8000-0000000c6001', 'th-owner@example.invalid', 'authenticated', 'authenticated'),
  ('aaaaaaaa-0000-4000-8000-0000000c6002', 'th-member@example.invalid', 'authenticated', 'authenticated'),
  ('bbbbbbbb-0000-4000-8000-0000000c6001', 'th-other@example.invalid', 'authenticated', 'authenticated');
insert into public.organizations (id, name) values
  ('aaaaaaaa-0000-4000-8000-0000000c60a0', 'Thresholds Org A'), ('bbbbbbbb-0000-4000-8000-0000000c60b0', 'Thresholds Org B');
insert into public.organization_members (organization_id, user_id, role) values
  ('aaaaaaaa-0000-4000-8000-0000000c60a0', 'aaaaaaaa-0000-4000-8000-0000000c6001', 'owner'),
  ('aaaaaaaa-0000-4000-8000-0000000c60a0', 'aaaaaaaa-0000-4000-8000-0000000c6002', 'member'),
  ('bbbbbbbb-0000-4000-8000-0000000c60b0', 'bbbbbbbb-0000-4000-8000-0000000c6001', 'owner');

set local role authenticated;

-- A member, before any change: the defaults (28 °C, 88 %, 70 %; low temperature and low CO₂ unset).
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-4000-8000-0000000c6002","role":"authenticated"}', true);
do $$
declare r record;
begin
  select * into r from public.climate_report_thresholds_in_effect('aaaaaaaa-0000-4000-8000-0000000c60a0');
  if r.high_temp <> 28 or r.high_rh <> 88 or r.low_day_rh <> 70 or r.low_temp is not null or r.low_day_co2 is not null or r.source <> 'default' then
    raise exception 'FAIL: defaults %', r;
  end if;
  -- A member can't change them.
  begin
    insert into public.climate_report_thresholds (organization_id, high_temp, high_rh, low_day_rh) values ('aaaaaaaa-0000-4000-8000-0000000c60a0', 30, 90, 65);
    raise exception 'FAIL: a member changed thresholds';
  exception when insufficient_privilege then null;
  end;
end $$;

-- The owner changes them (twice); the latest is in effect for everyone, the first is kept.
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-4000-8000-0000000c6001","role":"authenticated"}', true);
insert into public.climate_report_thresholds (organization_id, high_temp, high_rh, low_day_rh, low_day_co2, note)
  values ('aaaaaaaa-0000-4000-8000-0000000c60a0', 29, 88, 70, 400, 'CO₂ target from the grower');
insert into public.climate_report_thresholds (organization_id, high_temp, high_rh, low_day_rh, low_temp, low_day_co2, note)
  values ('aaaaaaaa-0000-4000-8000-0000000c60a0', 28, 90, 68, 15, 400, 'Night minimum added');
do $$
declare r record;
begin
  select * into r from public.climate_report_thresholds_in_effect('aaaaaaaa-0000-4000-8000-0000000c60a0');
  if r.source <> 'saved' or r.high_temp <> 28 or r.high_rh <> 90 or r.low_day_rh <> 68 or r.low_temp <> 15 or r.low_day_co2 <> 400
     or r.recorded_by <> 'aaaaaaaa-0000-4000-8000-0000000c6001' or r.note <> 'Night minimum added' then
    raise exception 'FAIL: in effect %', r;
  end if;
  if (select count(*) from public.climate_report_thresholds) <> 2 then raise exception 'FAIL: history'; end if;
  -- Not in someone else's name, not with a chosen time.
  begin
    insert into public.climate_report_thresholds (organization_id, high_temp, high_rh, low_day_rh, recorded_by)
      values ('aaaaaaaa-0000-4000-8000-0000000c60a0', 28, 88, 70, 'aaaaaaaa-0000-4000-8000-0000000c6002');
    raise exception 'FAIL: recorded in another name';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.climate_report_thresholds (organization_id, high_temp, high_rh, low_day_rh, recorded_at)
      values ('aaaaaaaa-0000-4000-8000-0000000c60a0', 28, 88, 70, '2020-01-01');
    raise exception 'FAIL: recorded_at chosen by the client';
  exception when insufficient_privilege then null;
  end;
  -- Values must make sense.
  begin
    insert into public.climate_report_thresholds (organization_id, high_temp, high_rh, low_day_rh) values ('aaaaaaaa-0000-4000-8000-0000000c60a0', 28, 70, 88);
    raise exception 'FAIL: low RH above high RH accepted';
  exception when check_violation then null;
  end;
  begin
    insert into public.climate_report_thresholds (organization_id, high_temp, high_rh, low_day_rh, low_temp) values ('aaaaaaaa-0000-4000-8000-0000000c60a0', 28, 88, 70, 30);
    raise exception 'FAIL: low temperature above high accepted';
  exception when check_violation then null;
  end;
  -- History can't be edited or removed.
  begin
    update public.climate_report_thresholds set high_temp = 40;
    raise exception 'FAIL: thresholds updated';
  exception when insufficient_privilege then null;
  end;
  begin
    delete from public.climate_report_thresholds;
    raise exception 'FAIL: thresholds deleted';
  exception when insufficient_privilege then null;
  end;
end $$;

-- Another organization: sees only its own (defaults) and can't change A's.
select set_config('request.jwt.claims', '{"sub":"bbbbbbbb-0000-4000-8000-0000000c6001","role":"authenticated"}', true);
do $$
begin
  if exists (select 1 from public.climate_report_thresholds) then raise exception 'FAIL: B sees A''s thresholds'; end if;
  if (select source from public.climate_report_thresholds_in_effect('bbbbbbbb-0000-4000-8000-0000000c60b0')) <> 'default' then raise exception 'FAIL: B defaults'; end if;
  begin
    insert into public.climate_report_thresholds (organization_id, high_temp, high_rh, low_day_rh) values ('aaaaaaaa-0000-4000-8000-0000000c60a0', 20, 80, 60);
    raise exception 'FAIL: B changed A''s thresholds';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

-- Even the table owner can't rewrite history (the trigger, not just privileges).
do $$
begin
  update public.climate_report_thresholds set high_temp = 40;
  raise exception 'FAIL: history rewritten';
exception when insufficient_privilege then null;
end $$;

-- Anonymous: nothing.
set local role anon;
do $$
begin
  perform 1 from public.climate_report_thresholds;
  raise exception 'FAIL: anon reads thresholds';
exception when insufficient_privilege then null;
end $$;
reset role;

select '{"result": "climate_report_thresholds tests passed"}';
rollback;
