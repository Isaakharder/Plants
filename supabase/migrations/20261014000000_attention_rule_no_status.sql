-- Plants: "No status yet" mobile attention rule
--
-- node_attention_rules gets a fifth rule for nodes that have never been
-- observed (default 7 days, counted from when the node was added). It is an
-- attention-rule key, not a node status: the column is renamed from status to
-- rule_key and accepts the seven node statuses plus 'NoStatus'. Node statuses
-- (node_observations.status) are unchanged.

alter table public.node_attention_rules rename column status to rule_key;
alter table public.node_attention_rules drop constraint node_attention_rules_status_check;
alter table public.node_attention_rules add constraint node_attention_rules_rule_key_check check (rule_key in (
  'NoStatus', 'Aborted', 'Pruned', 'Flower', 'SetFruit', 'MatureGreen', 'BreakerFruit', 'Harvested'
));

create or replace function public.seed_node_attention_rules()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.node_attention_rules (organization_id, rule_key, max_days, updated_by)
  values (new.id, 'NoStatus', 7, null), (new.id, 'Flower', 7, null), (new.id, 'SetFruit', 14, null),
         (new.id, 'MatureGreen', 49, null), (new.id, 'BreakerFruit', 14, null)
  on conflict do nothing;
  return new;
end;
$$;

insert into public.node_attention_rules (organization_id, rule_key, max_days, updated_by)
select id, 'NoStatus', 7, null from public.organizations
on conflict do nothing;
