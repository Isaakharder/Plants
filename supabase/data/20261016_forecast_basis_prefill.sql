-- One-off data script (not a migration): the forecast basis settings approved
-- on 2026-10-16, run once per environment after 20261024000000 is applied.
--
--   Mathieu          Full lifecycle from 2026-W01 (its records run W22–W41),
--                    Breakers only from 2026-W42 (85% harvest-ready share)
--   Cadalora, Silverstone, Phase 2 Levente, Phase 3 Levente
--                    Breakers only from 2026-W42 (85%)
--
-- Safe to repeat: a variety that already has any setting is left alone.
-- Refuses to run (and changes nothing) unless each name matches exactly one
-- variety. Adds rows only; nothing is changed or removed.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/data/20261016_forecast_basis_prefill.sql

begin;

do $$
declare
  v_plan constant jsonb := '[
    {"crop": "Mathieu",         "settings": [{"year": 2026, "week": 1,  "basis": "lifecycle"},
                                             {"year": 2026, "week": 42, "basis": "breaker_only", "share": 0.85}]},
    {"crop": "Cadalora",        "settings": [{"year": 2026, "week": 42, "basis": "breaker_only", "share": 0.85}]},
    {"crop": "Silverstone",     "settings": [{"year": 2026, "week": 42, "basis": "breaker_only", "share": 0.85}]},
    {"crop": "Phase 2 Levente", "settings": [{"year": 2026, "week": 42, "basis": "breaker_only", "share": 0.85}]},
    {"crop": "Phase 3 Levente", "settings": [{"year": 2026, "week": 42, "basis": "breaker_only", "share": 0.85}]}
  ]';
  v_item jsonb;
  v_setting jsonb;
  v_crop public.crops;
  v_matches integer;
  v_added integer := 0;
begin
  for v_item in select * from jsonb_array_elements(v_plan) loop
    select count(*) into v_matches from public.crops c where c.name = v_item ->> 'crop';
    if v_matches <> 1 then
      raise exception 'Expected exactly one variety named "%", found %', v_item ->> 'crop', v_matches;
    end if;
  end loop;

  for v_item in select * from jsonb_array_elements(v_plan) loop
    select * into v_crop from public.crops c where c.name = v_item ->> 'crop';
    if exists (select 1 from public.forecast_basis_settings s where s.crop_id = v_crop.id) then
      raise notice '%: already has forecast settings, left as they are', v_crop.name;
      continue;
    end if;
    for v_setting in select * from jsonb_array_elements(v_item -> 'settings') loop
      insert into public.forecast_basis_settings (organization_id, crop_id, from_year, from_week, basis, harvest_ready_share, note)
      values (v_crop.organization_id, v_crop.id, (v_setting ->> 'year')::integer, (v_setting ->> 'week')::integer, v_setting ->> 'basis',
              (v_setting ->> 'share')::numeric,
              case when v_setting ->> 'basis' = 'breaker_only'
                   then 'Pre-filled (approved 2026-10-16): Friday walkthroughs record Breakers only for the rest of 2026; 85% is the experimental Mathieu 2026 assumption.'
                   else 'Pre-filled (approved 2026-10-16): full lifecycle records through W41.' end);
      v_added := v_added + 1;
    end loop;
  end loop;
  raise notice 'Forecast settings added: %', v_added;
end $$;

commit;
