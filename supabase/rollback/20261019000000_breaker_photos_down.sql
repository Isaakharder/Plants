-- Rollback of 20261019000000_breaker_photos.sql. NOT a migration: run by hand,
-- only after reverting the app to a version without the photo feature.
--
-- Step 1 (always safe, keeps every photo): the app revert alone disables the
-- feature. Phones running the old app record Breaker without photos as
-- before; the tables, bucket and photos stay untouched.
--
-- Step 2 (only if no real photos exist, e.g. right after a failed rollout):
-- remove the schema. It refuses to run when any photo row exists, so photos
-- can never be deleted by this script. Objects in Storage are never deleted
-- here; remove an empty bucket from the Supabase dashboard if wanted.

begin;

do $$
begin
  if exists (select 1 from public.node_photos) then
    raise exception 'node_photos has % rows: keep the schema (step 1 only)', (select count(*) from public.node_photos);
  end if;
end $$;

drop policy if exists "node-photos: members read their organization's photos" on storage.objects;
drop policy if exists "node-photos: members add their organization's photos" on storage.objects;
drop table public.photo_pair_corrections;
drop table public.photo_colour_analyses;
drop table public.node_photos;
drop function public.photo_pair_corrections_check();
drop function public.node_photos_bind();
drop function public.is_member_of_path_org(text);
delete from supabase_migrations.schema_migrations where version = '20261019000000';

commit;
