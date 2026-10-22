-- Moves every auto-numbered id counter in the public schema (identity and
-- serial columns) forward to the highest id already stored in its table.
--
-- Run it after loading rows with their original ids into a database (a copy
-- or restore that inserts with OVERRIDING SYSTEM VALUE): such inserts don't
-- advance the counter, so the next normal insert would reuse an existing id
-- and fail with "duplicate key value violates unique constraint …_pkey"
-- (e.g. saving an AFW, whose history row gets its id from the counter).
--
-- Safe to run any time: it never lowers a counter and never touches a row.
--   psql … -f supabase/scripts/sync_identity_sequences.sql

do $$
declare
  r record;
  max_id bigint;
  last bigint;
  called boolean;
begin
  for r in
    select c.relname as tbl, a.attname as col, pg_get_serial_sequence(format('public.%I', c.relname), a.attname) as seq
      from pg_attribute a
      join pg_class c on c.oid = a.attrelid
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'r' and a.attnum > 0 and not a.attisdropped
       and pg_get_serial_sequence(format('public.%I', c.relname), a.attname) is not null
  loop
    execute format('select max(%I) from public.%I', r.col, r.tbl) into max_id;
    execute format('select last_value, is_called from %s', r.seq) into last, called;
    -- The next value the counter would hand out is last (+1 if already used).
    if max_id is not null and (case when called then last + 1 else last end) <= max_id then
      perform setval(r.seq, max_id, true);
      raise notice '%.%: counter moved from % to % (next id %)', r.tbl, r.col, last, max_id, max_id + 1;
    end if;
  end loop;
end $$;
