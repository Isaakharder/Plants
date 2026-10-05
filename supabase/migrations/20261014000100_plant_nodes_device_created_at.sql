-- Plants: keep the phone's creation time for nodes added offline
--
-- The collector now sends created_at: the moment the worker added the node on
-- the phone (stored with the queued write), so a node added offline on Monday
-- and synced on Friday is five days old on Friday, not new. A replayed insert
-- sends the same value and is ignored as before (ON CONFLICT (id) DO NOTHING).
--
-- A device clock can be wrong, so the time is only trusted when it is
-- plausible; otherwise the server's time is used, as before:
--   * later than now → now (a clock running ahead never makes a node "new");
--   * before the crop's planting date → now (a clock reset to an old date).
-- Existing nodes are not changed. Inserts without created_at keep the default.

create or replace function public.plant_nodes_validate_created_at()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  planted date;
begin
  if new.created_at > now() then
    new.created_at := now();
  else
    select c.planting_date into planted from public.crops c where c.id = new.crop_id;
    if planted is not null and new.created_at < planted::timestamptz - interval '1 day' then
      new.created_at := now();
    end if;
  end if;
  return new;
end;
$$;

create trigger plant_nodes_validate_created_at
  before insert on public.plant_nodes
  for each row execute function public.plant_nodes_validate_created_at();

revoke execute on function public.plant_nodes_validate_created_at() from public, anon, authenticated;
