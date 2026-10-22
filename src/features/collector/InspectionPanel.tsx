// Post-harvest inspection, on the row canvas: every fruit that was on the stem
// before the harvest must be answered. Still there → its status is recorded
// again (Breakers through the usual Breaker step, with optional photos);
// Harvested; or gone for another reason (the status picker: Aborted, Pruned).
// Each answer is an ordinary observation tied to this harvest's inspection.

import { nodeName } from '../harvests/model';
import type { NodeStatus, PlantNode } from './types';

const LABEL: Partial<Record<NodeStatus, string>> = {
  SetFruit: 'Set Fruit',
  MatureGreen: 'Mature Green',
  BreakerFruit: 'Breaker',
  Harvested: 'Harvested',
  Aborted: 'Aborted',
  Pruned: 'Pruned',
  Flower: 'Flower',
};

export function InspectionPanel({
  toConfirm,
  answered,
  nodes,
  latest,
  saving,
  onStillThere,
  onHarvested,
  onOther,
  onAllStillThere,
}: {
  toConfirm: string[];
  answered: Map<string, NodeStatus>;
  nodes: PlantNode[];
  latest: ReadonlyMap<string, NodeStatus>;
  saving: boolean;
  onStillThere: (node: PlantNode) => void;
  onHarvested: (node: PlantNode) => void;
  onOther: (node: PlantNode) => void;
  /** Every fruit still listed is still on the plant (Breakers recorded again without new photos). */
  onAllStillThere: (nodes: PlantNode[]) => void;
}) {
  const byId = new Map(nodes.map(n => [n.id, n]));
  const pending = toConfirm.map(id => byId.get(id)).filter((n): n is PlantNode => Boolean(n));
  const done = [...answered].map(([id, status]) => ({ node: byId.get(id), status })).filter(x => x.node);
  return (
    <div className="inspection-panel" aria-label="Fruit to confirm">
      {pending.length === 0 ? (
        <p className="inspection-panel-done">Every fruit on this stem is answered. Add any new fruit, then tap “✓ All fruit checked”.</p>
      ) : (
        <>
          <div className="inspection-panel-top">
            <p className="inspection-panel-head">
              {pending.length} fruit to confirm: is it still on the plant?
            </p>
            {pending.length > 1 && (
              <button type="button" className="btn btn-secondary btn-sm" disabled={saving} onClick={() => onAllStillThere(pending)}>
                All {pending.length} still there
              </button>
            )}
          </div>
          <ul className="inspection-list">
            {pending.map(node => (
              <li key={node.id} className="inspection-item">
                <span className="inspection-item-name">
                  {nodeName(node)} <span className="inspection-item-status">{LABEL[latest.get(node.id) as NodeStatus] ?? ''}</span>
                </span>
                <span className="inspection-item-actions">
                  <button type="button" className="btn btn-secondary btn-sm" disabled={saving} onClick={() => onStillThere(node)}>
                    Still there
                  </button>
                  <button type="button" className="btn btn-primary btn-sm" disabled={saving} onClick={() => onHarvested(node)}>
                    Harvested
                  </button>
                  <button type="button" className="btn btn-secondary btn-sm" disabled={saving} onClick={() => onOther(node)} aria-label={`${nodeName(node)}: gone for another reason`}>
                    Other…
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
      {done.length > 0 && (
        <p className="inspection-answered">
          Answered: {done.map(({ node, status }) => `${nodeName(node!)} ${LABEL[status] ?? status}`).join(' · ')}
        </p>
      )}
    </div>
  );
}
