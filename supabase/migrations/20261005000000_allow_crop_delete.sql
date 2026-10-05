-- Allow organization members to delete their organization's crops.
--
-- Development-phase rule: crops can be deleted outright. Once observations,
-- projections or harvest data reference crops, revisit this (e.g. FK
-- ON DELETE RESTRICT, or owner-only / archive instead of delete).

create policy "Members can delete crops"
  on public.crops for delete
  to authenticated
  using (public.is_org_member(organization_id));

grant delete on public.crops to authenticated;
