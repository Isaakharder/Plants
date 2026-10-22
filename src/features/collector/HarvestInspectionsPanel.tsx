// Home screen, per variety: harvests of the last weeks with sampled rows to
// inspect. Each sampled row opens the row canvas in inspection mode for that
// harvest; a row shows how many of its stems are inspected.

import type { HarvestEventInEffect } from '../../lib/database.types';
import { dayLabel, inspectedStems, rangesLabel } from '../harvests/model';
import type { MobileRowCard, StemVisit } from './types';

export function HarvestInspectionsPanel({
  harvests,
  rows,
  visits,
  onOpen,
}: {
  harvests: HarvestEventInEffect[];
  rows: MobileRowCard[];
  visits: StemVisit[];
  onOpen: (row: MobileRowCard, eventId: string) => void;
}) {
  if (harvests.length === 0) return null;
  return (
    <div className="harvest-inspections" aria-label="Harvests to inspect">
      <p className="harvest-inspections-head">Inspect after harvest</p>
      {harvests.slice(0, 6).map(h => {
        const done = inspectedStems(visits, h.event_id);
        const covered = h.sampled_rows.map(r => ({ sampled: r, card: rows.find(c => c.id === r.row_id) })).filter(x => x.card);
        const total = covered.reduce((n, x) => n + x.card!.stem_count, 0);
        const inspected = covered.reduce((n, x) => n + x.card!.stem_ids.filter(id => done.has(id)).length, 0);
        return (
          <div key={h.event_id} className={`harvest-inspection${total > 0 && inspected === total ? ' harvest-inspection--done' : ''}`}>
            <div className="harvest-inspection-title">
              <strong>{dayLabel(h.harvest_date)}</strong> · {rangesLabel(h.ranges)} · aim ≥ {h.min_colour_percent}%
              <span className="harvest-inspection-count">{inspected}/{total} stems</span>
            </div>
            <div className="harvest-inspection-rows">
              {covered.map(({ sampled, card }) => {
                const n = card!.stem_ids.filter(id => done.has(id)).length;
                return (
                  <button key={sampled.row_id} type="button" className="btn btn-secondary btn-sm" onClick={() => onOpen(card!, h.event_id)}>
                    {sampled.row_name}
                    {sampled.coverage === 'partial' ? ' (partial)' : ''} · {n}/{card!.stem_count}
                    {n === card!.stem_count && card!.stem_count > 0 ? ' ✓' : ''}
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
