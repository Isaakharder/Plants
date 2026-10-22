// Post-harvest inspection, on the row canvas: every fruit that was on the stem
// before the harvest must be answered. Still there → its status is recorded
// again (Breakers through the usual Breaker step, with optional photos);
// Harvested; or gone for another reason (the status picker: Aborted, Pruned).
// Each answer is an ordinary observation tied to this harvest's inspection.
//
// "All still there" is a shortcut, not a default: it first lists every fruit
// it will confirm and asks the employee to confirm each is on the plant.
// Answers can be changed (a newer answer replaces the earlier one) until the
// stem is completed, which shows them all for review first (StemReview).

import { useState } from 'react';
import { nodeName } from '../harvests/model';
import type { NodeStatus, PlantNode } from './types';

const ANSWER_LABEL: Partial<Record<NodeStatus, string>> = {
  SetFruit: 'Set Fruit',
  MatureGreen: 'Mature Green',
  BreakerFruit: 'Breaker',
  Harvested: 'Harvested',
  Aborted: 'Aborted',
  Pruned: 'Pruned',
  Flower: 'Flower',
};

const isRemoved = (s: NodeStatus) => s === 'Harvested' || s === 'Aborted' || s === 'Pruned';
const answerText = (s: NodeStatus) => (isRemoved(s) ? ANSWER_LABEL[s] : `still ${ANSWER_LABEL[s] ?? s}`);

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
  onChange,
}: {
  toConfirm: string[];
  answered: Map<string, NodeStatus>;
  nodes: PlantNode[];
  latest: ReadonlyMap<string, NodeStatus>;
  saving: boolean;
  onStillThere: (node: PlantNode) => void;
  onHarvested: (node: PlantNode) => void;
  onOther: (node: PlantNode) => void;
  /** Every listed fruit is physically on the plant (Breakers recorded again without new photos). */
  onAllStillThere: (nodes: PlantNode[]) => void;
  /** Change an answer already given (opens the status picker). */
  onChange: (node: PlantNode) => void;
}) {
  const [confirmingAll, setConfirmingAll] = useState(false);
  const byId = new Map(nodes.map(n => [n.id, n]));
  const pending = toConfirm.map(id => byId.get(id)).filter((n): n is PlantNode => Boolean(n));
  const done = [...answered]
    .map(([id, status]) => ({ node: byId.get(id), status }))
    .filter((x): x is { node: PlantNode; status: NodeStatus } => Boolean(x.node));

  return (
    <div className="inspection-panel" aria-label="Fruit to confirm">
      {pending.length === 0 ? (
        <p className="inspection-panel-done">Every fruit on this stem is answered. Add any new fruit, then tap “✓ All fruit checked”.</p>
      ) : confirmingAll ? (
        <div className="inspection-confirm-all" role="group" aria-label="Confirm all still on the plant">
          <p className="inspection-panel-head">Are all {pending.length} on the plant now?</p>
          <p className="inspection-confirm-text">Only confirm if you can see each of these fruit on the stem:</p>
          <ul className="inspection-confirm-list">
            {pending.map(node => (
              <li key={node.id}>
                {nodeName(node)} <span className="inspection-item-status">{ANSWER_LABEL[latest.get(node.id) as NodeStatus] ?? ''}</span>
              </li>
            ))}
          </ul>
          <p className="inspection-confirm-text">Breakers are recorded again without new photos; tap one afterwards to add photos.</p>
          <div className="inspection-item-actions">
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={saving}
              onClick={() => { setConfirmingAll(false); onAllStillThere(pending); }}
            >
              Yes, all {pending.length} are on the plant
            </button>
            <button type="button" className="btn btn-secondary btn-sm" disabled={saving} onClick={() => setConfirmingAll(false)}>
              Back
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="inspection-panel-top">
            <p className="inspection-panel-head">
              {pending.length} fruit to confirm: is it still on the plant?
            </p>
            {pending.length > 1 && (
              <button type="button" className="btn btn-secondary btn-sm" disabled={saving} onClick={() => setConfirmingAll(true)}>
                All {pending.length} still there…
              </button>
            )}
          </div>
          <ul className="inspection-list">
            {pending.map(node => (
              <li key={node.id} className="inspection-item">
                <span className="inspection-item-name">
                  {nodeName(node)} <span className="inspection-item-status">{ANSWER_LABEL[latest.get(node.id) as NodeStatus] ?? ''}</span>
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
      {done.length > 0 && !confirmingAll && (
        <div className="inspection-answered">
          <span>Answered (tap to change):</span>
          {done.map(({ node, status }) => (
            <button key={node.id} type="button" className="inspection-answer-chip" disabled={saving} onClick={() => onChange(node)}>
              {nodeName(node)}: {answerText(status)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Before a stem is completed: every answer of this inspection, to check or change. */
export function StemReview({
  stemName,
  answered,
  nodes,
  saving,
  onChange,
  onConfirm,
  onBack,
}: {
  stemName: string;
  answered: Map<string, NodeStatus>;
  nodes: PlantNode[];
  saving: boolean;
  onChange: (node: PlantNode) => void;
  onConfirm: () => void;
  onBack: () => void;
}) {
  const byId = new Map(nodes.map(n => [n.id, n]));
  const rows = [...answered]
    .map(([id, status]) => ({ node: byId.get(id), status }))
    .filter((x): x is { node: PlantNode; status: NodeStatus } => Boolean(x.node))
    .sort((a, b) => a.node.sort_order - b.node.sort_order || a.node.node_number - b.node.node_number);
  const removed = rows.filter(r => isRemoved(r.status)).length;
  return (
    <div className="modal-overlay" onClick={() => { if (!saving) onBack(); }}>
      <div className="modal" role="dialog" aria-label={`Review ${stemName}`} style={{ maxWidth: 440 }} onClick={e => e.stopPropagation()}>
        <div className="modal-title">Check {stemName} before completing</div>
        <p className="inspection-confirm-text">
          {rows.length - removed} still on the plant · {removed} removed. Tap an answer to change it.
        </p>
        <ul className="inspection-review-list">
          {rows.map(({ node, status }) => (
            <li key={node.id}>
              <button type="button" className="inspection-review-row" disabled={saving} onClick={() => onChange(node)}>
                <span>{nodeName(node)}</span>
                <span className={isRemoved(status) ? 'inspection-review-removed' : 'inspection-review-kept'}>
                  {isRemoved(status) ? ANSWER_LABEL[status] : `Still ${ANSWER_LABEL[status] ?? status}`}
                </span>
              </button>
            </li>
          ))}
        </ul>
        <div className="modal-actions">
          <button type="button" className="btn btn-secondary" disabled={saving} onClick={onBack}>Back</button>
          <button type="button" className="btn btn-primary" disabled={saving} onClick={onConfirm}>Complete {stemName}</button>
        </div>
      </div>
    </div>
  );
}
