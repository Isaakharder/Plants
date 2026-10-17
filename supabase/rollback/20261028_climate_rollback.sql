-- ROLLBACK ONLY — never run as a migration. Removes everything migrations
-- 20261027000000_climate_ingest and 20261028000000_climate_review_and_monitoring
-- created, in dependency order, and their entries in the migration history.
--
-- It DELETES all climate data (original files, readings, zones, keys, planting
-- assignments, reviews). Before running it in an environment that has received
-- climate files, export the climate tables (see 20261028_climate_recovery.md).
-- No other table, function, policy or row is touched.
--
--   supabase db query --linked -f supabase/rollback/20261028_climate_rollback.sql

begin;

drop function if exists public.crop_climate_series(uuid, text[], timestamptz, timestamptz, timestamptz);
drop function if exists public.climate_import_status(uuid);
drop function if exists public.climate_missing_hours(uuid, timestamptz, timestamptz);
drop function if exists public.climate_daily(uuid, uuid[], text[], date, date);
drop function if exists public.climate_series(uuid, uuid[], text[], timestamptz, timestamptz);
drop function if exists public.climate_user_is_owner(uuid, uuid);
drop function if exists public.climate_set_zone_display_name(uuid, text);
drop function if exists public.climate_resolve_quarantined_file(uuid, uuid, jsonb, text);
drop function if exists public.climate_review_file(uuid, text, text);
drop table if exists public.climate_file_reviews;

drop function if exists public.crop_climate_readings(uuid, timestamptz, timestamptz, timestamptz);
drop function if exists public.crop_climate_zones_at(uuid, date, timestamptz);
drop function if exists public.set_crop_climate_zones(uuid, date, jsonb, text);
drop function if exists public.climate_ingest_file(uuid, text, uuid, uuid, text, text, text, text, jsonb);
drop function if exists public.climate_agent_authenticate(text, text);
drop function if exists public.climate_revoke_agent_key(uuid);
drop function if exists public.climate_create_agent_key(uuid, text, timestamptz);
drop function if exists public.climate_create_source(uuid, text);
drop view if exists public.climate_readings_active;
drop table if exists public.crop_climate_zones;
drop table if exists public.climate_import_attempts;
drop table if exists public.climate_readings;
drop table if exists public.climate_import_files;
drop table if exists public.climate_zones;
drop table if exists public.climate_agent_keys;
drop table if exists public.climate_sources;
drop function if exists public.crop_climate_zones_guard();
drop function if exists public.climate_import_files_guard();
drop function if exists public.climate_zones_guard();
drop function if exists public.climate_history_immutable();

delete from supabase_migrations.schema_migrations where version in ('20261027000000', '20261028000000');

commit;
