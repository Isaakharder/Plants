-- Rollback of 20261019120000_breaker_photo_replacements.sql. NOT a migration:
-- run by hand, only after reverting the app to a version without photo
-- replacement and duplicate marking.
--
-- It refuses to run while any replacement photo or duplicate correction
-- exists, so no record is ever removed or changed by this script.

begin;

do $$
begin
  if exists (select 1 from public.node_photos where replaces_photo_id is not null) then
    raise exception 'Replacement photos exist: keep the schema';
  end if;
  if exists (select 1 from public.photo_pair_corrections where kind = 'duplicate') then
    raise exception 'Duplicate corrections exist: keep the schema';
  end if;
end $$;

drop trigger photo_pair_corrections_duplicate_check on public.photo_pair_corrections;
drop function public.photo_pair_corrections_duplicate_check();
alter table public.photo_pair_corrections
  drop constraint photo_pair_corrections_duplicate_shape,
  drop constraint photo_pair_corrections_kind_check,
  drop column duplicate_of_observation_id,
  add constraint photo_pair_corrections_kind_check check (kind in ('reassign_node', 'unusable', 'restore'));

drop trigger node_photos_replacement_check on public.node_photos;
drop function public.node_photos_replacement_check();
drop index public.node_photos_replaces_idx;
alter table public.node_photos drop column replaces_photo_id;

delete from supabase_migrations.schema_migrations where version = '20261019120000';

commit;
