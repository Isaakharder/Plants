// Home screen, per variety: this week's "✓ Stem checked" progress and the
// "Mark sampling complete" action, plus a reminder when last week's sampling
// was started but never marked complete.

import { useState } from 'react';
import { completionNote, type CropWeekProgress } from './samplingProgress';
import type { GreenhouseWeek } from './greenhouseWeek';

type Props = {
  varietyName: string;
  current: CropWeekProgress;
  /** Last week's progress, when it had checks but was never marked complete. */
  unfinishedPrevious: CropWeekProgress | null;
  onComplete: (week: GreenhouseWeek, note: string, seen: { checked: number; expected: number }) => Promise<void>;
  onReopen: (week: GreenhouseWeek) => Promise<void>;
};

export function SamplingWeekPanel({ varietyName, current, unfinishedPrevious, onComplete, onReopen }: Props) {
  const [confirming, setConfirming] = useState<{ progress: CropWeekProgress; mode: 'complete' | 'reopen' } | null>(null);
  const pct = current.expected === 0 ? 0 : Math.round((100 * current.checked) / current.expected);

  return (
    <>
      <div className={`sampling-week${current.complete ? ' sampling-week--complete' : ''}`}>
        <div className="sampling-week-text">
          {current.complete ? (
            <strong>✓ W{current.week.week} sampling complete</strong>
          ) : (
            <strong>W{current.week.week}: {current.checked} of {current.expected} stems checked</strong>
          )}
          {current.complete && current.checked < current.expected && (
            <span className="sampling-week-sub">{current.expected - current.checked} not checked</span>
          )}
          <div className="sampling-week-bar" aria-hidden="true">
            <div style={{ width: `${pct}%` }} />
          </div>
        </div>
        {current.complete ? (
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => setConfirming({ progress: current, mode: 'reopen' })}>
            Reopen
          </button>
        ) : (
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={current.expected === 0}
            onClick={() => setConfirming({ progress: current, mode: 'complete' })}
          >
            Mark sampling complete
          </button>
        )}
      </div>

      {unfinishedPrevious && (
        <div className="sampling-week sampling-week--previous">
          <div className="sampling-week-text">
            <strong>W{unfinishedPrevious.week.week} was not marked complete</strong>
            <span className="sampling-week-sub">
              {unfinishedPrevious.checked} of {unfinishedPrevious.expected} stems checked
            </span>
          </div>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => setConfirming({ progress: unfinishedPrevious, mode: 'complete' })}>
            Mark W{unfinishedPrevious.week.week} complete
          </button>
        </div>
      )}

      {confirming && (
        <ConfirmSampling
          varietyName={varietyName}
          progress={confirming.progress}
          mode={confirming.mode}
          onClose={() => setConfirming(null)}
          onConfirm={async () => {
            if (confirming.mode === 'complete')
              await onComplete(confirming.progress.week, completionNote(confirming.progress), { checked: confirming.progress.checked, expected: confirming.progress.expected });
            else await onReopen(confirming.progress.week);
            setConfirming(null);
          }}
        />
      )}
    </>
  );
}

function ConfirmSampling({
  varietyName,
  progress,
  mode,
  onClose,
  onConfirm,
}: {
  varietyName: string;
  progress: CropWeekProgress;
  mode: 'complete' | 'reopen';
  onClose: () => void;
  onConfirm: () => Promise<void>;
}) {
  const missing = progress.expected - progress.checked;
  const [acknowledged, setAcknowledged] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const canConfirm = mode === 'reopen' || missing === 0 || acknowledged;

  async function confirm() {
    setSaving(true);
    setError('');
    try {
      await onConfirm();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSaving(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" role="dialog" aria-label={mode === 'complete' ? 'Mark sampling complete' : 'Reopen sampling'} onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">
          {mode === 'complete' ? `Mark W${progress.week.week} sampling complete` : `Reopen W${progress.week.week} sampling`}
          <span style={{ fontWeight: 400, color: 'var(--gray-500)', marginLeft: 8 }}>{varietyName}</span>
        </div>

        {mode === 'reopen' ? (
          <p className="sampling-confirm-text">
            The week will be in progress again so more stems can be checked. Mark it complete again when sampling is finished.
          </p>
        ) : (
          <>
            <p className="sampling-confirm-count">
              <strong>{progress.checked}</strong> of <strong>{progress.expected}</strong> stems checked
            </p>
            {missing > 0 ? (
              <div className="alert alert-warning">
                <strong>Sampling is incomplete: {missing} stem{missing === 1 ? ' was' : 's were'} not checked.</strong>
                <ul className="sampling-confirm-list">
                  {progress.uncheckedByRow.map((r) => (
                    <li key={r.rowId}>
                      {r.rowName}: {r.unchecked} not checked
                    </li>
                  ))}
                </ul>
                <label className="sampling-confirm-ack">
                  <input type="checkbox" checked={acknowledged} onChange={(e) => setAcknowledged(e.target.checked)} />
                  <span>
                    Complete anyway. The {missing} unchecked stem{missing === 1 ? '' : 's'} will count as not visited this week (never as checked,
                    and never as zero harvests).
                  </span>
                </label>
              </div>
            ) : (
              <p className="sampling-confirm-text">Every stem has been checked.</p>
            )}
          </>
        )}

        {error && <div className="alert alert-error">{error}</div>}
        <div className="modal-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={() => void confirm()} disabled={!canConfirm || saving}>
            {saving ? 'Saving…' : mode === 'complete' ? 'Mark complete' : 'Reopen'}
          </button>
        </div>
      </div>
    </div>
  );
}
