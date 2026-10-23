-- 20261109000000_pepper_types: pepper types as separate forecasting model
-- groups. Existing crops are Bell Pepper; new crops must name a type of their
-- own organization; pepper_type_cohort_outcomes() never crosses types.
--
-- Runs inside a transaction that is always rolled back.
-- Prints {"result": "pepper_types tests passed"} on success.

begin;

-- ── Every crop that already exists is a Bell Pepper of its own organization ──
do $$
begin
  if exists (
    select 1 from public.crops c join public.pepper_types t on t.id = c.pepper_type_id
     where t.key <> 'bell' or t.organization_id <> c.organization_id
  ) then
    raise exception 'an existing crop is not its organization''s Bell Pepper';
  end if;
  if exists (select 1 from public.organizations o where (select count(*) from public.pepper_types t where t.organization_id = o.id and t.key in ('bell', 'long_pointed')) <> 2) then
    raise exception 'an organization is missing its pepper types';
  end if;
  if exists (select 1 from public.pepper_types where key = 'bell' and (provisional_survival <> 0.6 or provisional_timing <> '{0,0,0,0,0,0.2,0.3,0.3,0.2,0,0}'::numeric[] or default_afw_g is not null or pool_within_type)) then
    raise exception 'Bell Pepper is not seeded with the values the outlook used until now';
  end if;
  if exists (select 1 from public.pepper_types where key = 'long_pointed' and (provisional_survival is not null or provisional_timing is not null or default_afw_g is not null or pool_within_type)) then
    raise exception 'Long Pointed Pepper must start with nothing configured (never bell values)';
  end if;
end $$;

-- ── Fixture: org P (owner + member) with a bell and a long pointed variety; org Q ──
insert into auth.users (id, email, aud, role) values
  ('dddddddd-0000-4000-8000-0000000000d1', 'pt-owner@example.invalid', 'authenticated', 'authenticated'),
  ('dddddddd-0000-4000-8000-0000000000d2', 'pt-member@example.invalid', 'authenticated', 'authenticated'),
  ('dddddddd-0000-4000-8000-0000000000d9', 'pt-out@example.invalid', 'authenticated', 'authenticated');
insert into public.organizations (id, name) values
  ('dddddddd-0000-4000-8000-0000000000a0', 'PT Org'),
  ('dddddddd-0000-4000-8000-0000000000b0', 'PT Other Org');
insert into public.organization_members (organization_id, user_id, role) values
  ('dddddddd-0000-4000-8000-0000000000a0', 'dddddddd-0000-4000-8000-0000000000d1', 'owner'),
  ('dddddddd-0000-4000-8000-0000000000a0', 'dddddddd-0000-4000-8000-0000000000d2', 'member');

-- New organizations get both types (trigger).
do $$
begin
  if (select count(*) from public.pepper_types where organization_id = 'dddddddd-0000-4000-8000-0000000000a0') <> 2 then
    raise exception 'a new organization did not get its pepper types';
  end if;
end $$;

create function pg_temp.type_id(org uuid, k text) returns uuid language sql stable as
  $$ select id from public.pepper_types where organization_id = org and key = k $$;

insert into public.crops (id, organization_id, name, color, planting_date, pullout_date, area_m2, picking_stems, pepper_type_id) values
  ('dddddddd-0000-4000-8000-00000000cb01', 'dddddddd-0000-4000-8000-0000000000a0', 'Bell B', 'red', '2026-01-01', '2026-12-31', 100, 700,
   pg_temp.type_id('dddddddd-0000-4000-8000-0000000000a0', 'bell')),
  ('dddddddd-0000-4000-8000-00000000cf01', 'dddddddd-0000-4000-8000-0000000000a0', 'Pietro Test', 'red', '2026-01-01', '2026-12-31', 100, 700,
   pg_temp.type_id('dddddddd-0000-4000-8000-0000000000a0', 'long_pointed'));

-- A crop must name a pepper type, and one of its own organization.
do $$
begin
  insert into public.crops (organization_id, name, color, planting_date, pullout_date, area_m2, picking_stems)
  values ('dddddddd-0000-4000-8000-0000000000a0', 'No type', 'red', '2026-01-01', '2026-12-31', 100, 700);
  raise exception 'a crop without a pepper type was accepted';
exception when not_null_violation then null;
end $$;
do $$
begin
  insert into public.crops (organization_id, name, color, planting_date, pullout_date, area_m2, picking_stems, pepper_type_id)
  values ('dddddddd-0000-4000-8000-0000000000a0', 'Foreign type', 'red', '2026-01-01', '2026-12-31', 100, 700,
          pg_temp.type_id('dddddddd-0000-4000-8000-0000000000b0', 'bell'));
  raise exception 'a crop with another organization''s pepper type was accepted';
exception when foreign_key_violation then null;
end $$;

-- Timing shares: 11 ages, adding up to 1.
do $$
begin
  update public.pepper_types set provisional_timing = '{0,0,0,0,0,0.5,0.4,0,0,0,0}' where id = pg_temp.type_id('dddddddd-0000-4000-8000-0000000000a0', 'long_pointed');
  raise exception 'timing adding up to 90%% was accepted';
exception when check_violation then null;
end $$;
do $$
begin
  update public.pepper_types set provisional_timing = '{0.5,0.5}' where id = pg_temp.type_id('dddddddd-0000-4000-8000-0000000000a0', 'long_pointed');
  raise exception 'timing with 2 ages was accepted';
exception when check_violation then null;
end $$;

-- Variety overrides: valid values save; invalid ones are refused by the database too.
do $$
begin
  update public.crops set sets_provisional_survival = 0.55, sets_provisional_timing = '{0,0,0,0,0,0,0.4,0.6,0,0,0}'
   where id = 'dddddddd-0000-4000-8000-00000000cb01';
  update public.crops set sets_provisional_survival = null, sets_provisional_timing = null
   where id = 'dddddddd-0000-4000-8000-00000000cb01';
  begin
    update public.crops set sets_provisional_timing = '{0,0,0,0,0,0,0.4,0.5,0,0,0}' where id = 'dddddddd-0000-4000-8000-00000000cb01';
    raise exception 'variety timing adding up to 90%% was accepted';
  exception when check_violation then null;
  end;
  begin
    update public.crops set sets_provisional_survival = 1.5 where id = 'dddddddd-0000-4000-8000-00000000cb01';
    raise exception 'variety survival above 100%% was accepted';
  exception when check_violation then null;
  end;
end $$;

-- One stem per variety; peppers set in W11, harvested W18 (bell) and W17 (long).
insert into public.measurement_rows (id, organization_id, crop_id, row_name) values
  ('dddddddd-0000-4000-8000-0000000001b1', 'dddddddd-0000-4000-8000-0000000000a0', 'dddddddd-0000-4000-8000-00000000cb01', 'Row B'),
  ('dddddddd-0000-4000-8000-0000000001f1', 'dddddddd-0000-4000-8000-0000000000a0', 'dddddddd-0000-4000-8000-00000000cf01', 'Row L');
insert into public.measurement_stems (id, organization_id, crop_id, measurement_row_id, stem_name) values
  ('dddddddd-0000-4000-8000-0000000002b1', 'dddddddd-0000-4000-8000-0000000000a0', 'dddddddd-0000-4000-8000-00000000cb01', 'dddddddd-0000-4000-8000-0000000001b1', 'SB'),
  ('dddddddd-0000-4000-8000-0000000002f1', 'dddddddd-0000-4000-8000-0000000000a0', 'dddddddd-0000-4000-8000-00000000cf01', 'dddddddd-0000-4000-8000-0000000001f1', 'SL');
insert into public.plant_nodes (id, organization_id, crop_id, measurement_stem_id, node_number, is_side_shoot, is_active)
select ('dddddddd-0000-4000-8000-0000000003' || id)::uuid, 'dddddddd-0000-4000-8000-0000000000a0', crop::uuid, stem::uuid, num, false, true
from (values
  ('b1', 'dddddddd-0000-4000-8000-00000000cb01', 'dddddddd-0000-4000-8000-0000000002b1', 1),
  ('b2', 'dddddddd-0000-4000-8000-00000000cb01', 'dddddddd-0000-4000-8000-0000000002b1', 2),
  ('f1', 'dddddddd-0000-4000-8000-00000000cf01', 'dddddddd-0000-4000-8000-0000000002f1', 1),
  ('f2', 'dddddddd-0000-4000-8000-00000000cf01', 'dddddddd-0000-4000-8000-0000000002f1', 2)
) v(id, crop, stem, num);
insert into public.node_observations (organization_id, crop_id, plant_node_id, year, week_number, status, observed_at)
select 'dddddddd-0000-4000-8000-0000000000a0', crop::uuid, ('dddddddd-0000-4000-8000-0000000003' || n)::uuid,
       2026, w, s, to_date('2026-' || lpad(w::text, 2, '0'), 'IYYY-IW') + interval '1 day 12 hours'
from (values
  ('b1', 'dddddddd-0000-4000-8000-00000000cb01', 10, 'Flower'), ('b1', 'dddddddd-0000-4000-8000-00000000cb01', 11, 'SetFruit'), ('b1', 'dddddddd-0000-4000-8000-00000000cb01', 18, 'Harvested'),
  ('b2', 'dddddddd-0000-4000-8000-00000000cb01', 10, 'Flower'), ('b2', 'dddddddd-0000-4000-8000-00000000cb01', 11, 'SetFruit'), ('b2', 'dddddddd-0000-4000-8000-00000000cb01', 12, 'Aborted'),
  ('f1', 'dddddddd-0000-4000-8000-00000000cf01', 10, 'Flower'), ('f1', 'dddddddd-0000-4000-8000-00000000cf01', 11, 'SetFruit'), ('f1', 'dddddddd-0000-4000-8000-00000000cf01', 17, 'Harvested'),
  ('f2', 'dddddddd-0000-4000-8000-00000000cf01', 10, 'Flower'), ('f2', 'dddddddd-0000-4000-8000-00000000cf01', 11, 'SetFruit')
) v(n, crop, w, s);

-- ── Isolation at the data-query level ───────────────────────────────────────
create temp table bell_before on commit drop as
  select * from public.pepper_type_cohort_outcomes(pg_temp.type_id('dddddddd-0000-4000-8000-0000000000a0', 'bell'), 2026);

do $$
declare
  bell uuid := pg_temp.type_id('dddddddd-0000-4000-8000-0000000000a0', 'bell');
  long uuid := pg_temp.type_id('dddddddd-0000-4000-8000-0000000000a0', 'long_pointed');
begin
  if exists (select 1 from public.pepper_type_cohort_outcomes(bell, 2026) where crop_id <> 'dddddddd-0000-4000-8000-00000000cb01' or pepper_type_id <> bell) then
    raise exception 'bell outcomes include another variety or type';
  end if;
  if exists (select 1 from public.pepper_type_cohort_outcomes(long, 2026) where crop_id <> 'dddddddd-0000-4000-8000-00000000cf01' or pepper_type_id <> long) then
    raise exception 'long pointed outcomes include another variety or type';
  end if;
  if (select harvested_by_age[8] from public.pepper_type_cohort_outcomes(bell, 2026) where set_week = 11) <> 1
     or (select aborted_by_age[2] from public.pepper_type_cohort_outcomes(bell, 2026) where set_week = 11) <> 1 then
    raise exception 'bell cohort outcomes wrong';
  end if;
  if (select harvested_by_age[7] from public.pepper_type_cohort_outcomes(long, 2026) where set_week = 11) <> 1
     or (select on_plant from public.pepper_type_cohort_outcomes(long, 2026) where set_week = 11) <> 1 then
    raise exception 'long pointed cohort outcomes wrong';
  end if;
end $$;

-- More long pointed observations change nothing for bell.
insert into public.node_observations (organization_id, crop_id, plant_node_id, year, week_number, status, observed_at)
values ('dddddddd-0000-4000-8000-0000000000a0', 'dddddddd-0000-4000-8000-00000000cf01', 'dddddddd-0000-4000-8000-0000000003f2', 2026, 16, 'Aborted',
        to_date('2026-16', 'IYYY-IW') + interval '1 day 12 hours');
do $$
begin
  if exists (
    (select * from bell_before except select * from public.pepper_type_cohort_outcomes(pg_temp.type_id('dddddddd-0000-4000-8000-0000000000a0', 'bell'), 2026))
    union all
    (select * from public.pepper_type_cohort_outcomes(pg_temp.type_id('dddddddd-0000-4000-8000-0000000000a0', 'bell'), 2026) except select * from bell_before)
  ) then
    raise exception 'long pointed observations changed bell outcomes';
  end if;
  if (select aborted_by_age[6] from public.pepper_type_cohort_outcomes(pg_temp.type_id('dddddddd-0000-4000-8000-0000000000a0', 'long_pointed'), 2026) where set_week = 11) <> 1 then
    raise exception 'the long pointed abort was not counted for long pointed';
  end if;
end $$;

-- ── Access ──────────────────────────────────────────────────────────────────
create temp table ids on commit drop as
  select key, id from public.pepper_types where organization_id = 'dddddddd-0000-4000-8000-0000000000a0';
grant select on ids to authenticated, anon;

set local role authenticated;
-- A member reads the types but cannot change assumptions.
select set_config('request.jwt.claims', '{"sub": "dddddddd-0000-4000-8000-0000000000d2", "role": "authenticated"}', true);
do $$
declare n integer;
begin
  if (select count(*) from public.pepper_types where organization_id = 'dddddddd-0000-4000-8000-0000000000a0') <> 2 then raise exception 'the member cannot read the types'; end if;
  update public.pepper_types set provisional_survival = 0.5 where id = (select id from ids where key = 'long_pointed');
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'a member changed pepper type assumptions'; end if;
  if (select count(*) from public.pepper_type_cohort_outcomes((select id from ids where key = 'bell'), 2026)) <> 1 then raise exception 'the member does not see bell cohorts'; end if;
end $$;
-- The owner can.
select set_config('request.jwt.claims', '{"sub": "dddddddd-0000-4000-8000-0000000000d1", "role": "authenticated"}', true);
do $$
declare n integer;
begin
  update public.pepper_types set provisional_survival = 0.55, provisional_timing = '{0,0,0,0,0.3,0.4,0.3,0,0,0,0}' where id = (select id from ids where key = 'long_pointed');
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'the owner could not set long pointed assumptions'; end if;
end $$;
-- An outsider sees nothing.
select set_config('request.jwt.claims', '{"sub": "dddddddd-0000-4000-8000-0000000000d9", "role": "authenticated"}', true);
do $$
begin
  if exists (select 1 from public.pepper_types where organization_id = 'dddddddd-0000-4000-8000-0000000000a0') then raise exception 'an outsider sees pepper types'; end if;
  if exists (select 1 from public.pepper_type_cohort_outcomes((select id from ids where key = 'bell'), 2026)) then raise exception 'an outsider sees cohorts'; end if;
end $$;
reset role;
set local role anon;
do $$
begin
  perform public.pepper_type_cohort_outcomes((select id from ids where key = 'bell'), 2026);
  raise exception 'anon can call pepper_type_cohort_outcomes';
exception when insufficient_privilege then null;
end $$;
reset role;

select '{"result": "pepper_types tests passed"}' as result;
rollback;
