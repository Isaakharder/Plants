// Harvestable this week: one tap in the status picker, above whatever the
// picker shows for the node (the status grid, "Still Breaker?" or "Breaker
// already recorded"). It never records a status; see harvestable.ts.

import type { HarvestableMark } from './types';

const timeLabel = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { timeZone: 'America/Toronto', weekday: 'short', hour: 'numeric', minute: '2-digit' });

export function HarvestableToggle({
  week,
  mark,
  saving,
  onMark,
  onUndo,
}: {
  week: number;
  /** This week's mark in effect, or null. */
  mark: HarvestableMark | null;
  saving: boolean;
  onMark: () => void;
  onUndo: () => void;
}) {
  if (mark) {
    return (
      <div className="harvestable-toggle harvestable-toggle--on" role="status">
        <span>
          ✓ Harvestable W{week}
          <small>Marked {timeLabel(mark.observed_at)}. Counted once this week.</small>
        </span>
        <button type="button" className="btn btn-secondary" disabled={saving} onClick={onUndo}>Undo</button>
      </div>
    );
  }
  return (
    <button type="button" className="btn harvestable-toggle harvestable-toggle--off" disabled={saving} onClick={onMark}>
      {saving ? 'Saving…' : `Harvestable (pick this week, W${week})`}
    </button>
  );
}
