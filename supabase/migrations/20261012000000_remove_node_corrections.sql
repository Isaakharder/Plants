-- Plants: remove desktop node corrections
--
-- 20261011000000_node_corrections.sql added office-side corrections (renumber,
-- shoot fixes, soft removal, undo) with a correction log. The Plants page stays
-- a read-only digital twin instead: it detects and explains problems, and
-- structural fixes will be made in the mobile collector by the worker at the
-- plant. The log was never used (it is empty), so it is dropped together with
-- the correction functions.
--
-- Kept from 20261011000000:
--   * Deactivating a main node deactivates its side shoots, and a shoot saved
--     under an inactive parent is stored inactive (plant_nodes_cascade_deactivate,
--     plant_nodes_shoot_follows_parent). A data-correctness fix: a removed
--     node's shoots no longer count in the plant/cohort calculations.
--   * Clients may update only plant_nodes.is_active, and only to false. That is
--     the one direct update the collector makes (discarding a node it just
--     created, replayed safely from the offline queue). Anything else, such as
--     a future collector correction, should be a dedicated, logged function.

do $$
begin
  if exists (select 1 from public.node_corrections) then
    raise exception 'node_corrections is not empty; refusing to drop recorded corrections';
  end if;
end $$;

drop function public.correct_node_renumber(uuid, uuid, integer, text, jsonb);
drop function public.correct_node_shoot(uuid, uuid, uuid, integer, text, text, jsonb);
drop function public.correct_node_remove(uuid, uuid, text, jsonb);
drop function public.undo_node_correction(uuid, uuid, text);

drop function public._correction_log(uuid, text, public.plant_nodes, uuid[], jsonb, text, jsonb, uuid);
drop function public._correction_replay(uuid, text, uuid);
drop function public._correction_node(uuid);
drop function public._correction_reason(text);
drop function public._correction_expect(jsonb, uuid[]);
drop function public._conflicts_of(uuid[]);
drop function public._snapshots(uuid[]);
drop function public._node_identity_conflicts(jsonb, uuid, uuid[]);
drop function public._node_snapshot(public.plant_nodes);
drop function public._shoot_index(text);

-- Its policy, indexes and constraints go with it.
drop table public.node_corrections;
