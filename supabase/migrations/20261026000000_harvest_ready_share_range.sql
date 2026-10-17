-- Plants: the harvest-ready share can be set anywhere from 0% to 100%
-- (was 5–100%), now that it is edited directly in the Harvest Forecast table.
--
-- Widens one check only: every existing setting (85%) still satisfies it.
-- No row is changed.

alter table public.forecast_basis_settings
  drop constraint forecast_basis_settings_harvest_ready_share_check,
  add constraint forecast_basis_settings_harvest_ready_share_check
    check (harvest_ready_share is null or (harvest_ready_share >= 0 and harvest_ready_share <= 1));
