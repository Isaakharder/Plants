// Camera-first Breaker recording: the front and the back of the pepper are
// photographed before the Breaker record is saved. "Record without photos"
// keeps the manual workflow available at any time.
//
// Every photo taken is kept on the phone as a draft at once, so a reload
// (phones may reload the page while the camera is open or the screen is
// locked) never loses it: reopening this node's Breaker step restores it.

import { useEffect, useRef, useState } from 'react';
import type { PhotoSide } from '../../lib/database.types';
import { captureDrafts, draftKey, type CaptureDraft } from './offline/captureDrafts';
import { preparePhoto, requestPersistentStorage, type PreparedPhoto } from './photos';

type Shot = PreparedPhoto & { url: string };

const SIDES: { side: PhotoSide; label: string; hint: string }[] = [
  { side: 'front', label: 'Front', hint: 'The side facing the aisle' },
  { side: 'back', label: 'Back', hint: 'Turn the pepper gently, or shoot from behind' },
];

export function BreakerCapture({
  userId,
  nodeId,
  stemId,
  nodeLabel,
  saving,
  onSave,
  onManual,
  onBack,
}: {
  userId: string;
  nodeId: string;
  stemId: string;
  nodeLabel: string;
  saving: boolean;
  /** captureSeconds: from first opening the photo step (across reloads) to saving. */
  onSave: (photos: PreparedPhoto[], timing: { captureSeconds: number }) => void;
  onManual: () => void;
  onBack: () => void;
}) {
  const [shots, setShots] = useState<Partial<Record<PhotoSide, Shot>>>({});
  const [error, setError] = useState('');
  const [reading, setReading] = useState<PhotoSide | null>(null);
  const [restored, setRestored] = useState(false);
  const urls = useRef<string[]>([]);
  const startedAt = useRef(0);
  const key = draftKey(userId, nodeId);

  const withUrl = (p: PreparedPhoto): Shot => {
    const url = URL.createObjectURL(p.preview ?? p.image);
    urls.current.push(url);
    return { ...p, url };
  };

  // Restore photos taken before a reload; keep stored data safe; free previews on close.
  useEffect(() => {
    startedAt.current = Date.now();
    requestPersistentStorage();
    let cancelled = false;
    void captureDrafts()
      .get(key)
      .then(draft => {
        if (cancelled || !draft || Object.keys(draft.shots).length === 0) return;
        startedAt.current = draft.startedAt;
        const restoredShots: Partial<Record<PhotoSide, Shot>> = {};
        for (const side of ['front', 'back'] as PhotoSide[]) {
          const p = draft.shots[side];
          if (p) restoredShots[side] = withUrl(p);
        }
        setShots(restoredShots);
        setRestored(true);
      })
      .catch(() => {});
    const created = urls.current;
    return () => {
      cancelled = true;
      created.forEach(u => URL.revokeObjectURL(u));
    };
    // withUrl only touches the ref; restoring once per node is intended.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  async function take(side: PhotoSide, file: File | undefined) {
    if (!file) return;
    setError('');
    setReading(side);
    try {
      const photo = await preparePhoto(side, file);
      const next = { ...shots, [side]: withUrl(photo) };
      setShots(next);
      const stored: CaptureDraft['shots'] = {};
      for (const s of ['front', 'back'] as PhotoSide[]) {
        const shot = next[s];
        if (shot) {
          const { url: _url, ...prepared } = shot;
          stored[s] = prepared;
        }
      }
      await captureDrafts().put({ key, userId, nodeId, stemId, startedAt: startedAt.current, savedAt: Date.now(), shots: stored });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setReading(null);
    }
  }

  async function discard() {
    await captureDrafts().delete(key).catch(() => {});
    setShots({});
    setRestored(false);
    startedAt.current = Date.now();
  }

  const ready = Boolean(shots.front && shots.back);

  return (
    <div className="breaker-capture">
      <p className="breaker-capture-intro">
        Photograph <strong>{nodeLabel}</strong>: the front, then the back. Fill the frame with the pepper, avoid direct sun and keep the
        whole fruit in view.
      </p>
      {restored && <div className="alert alert-info">The photos you took earlier for {nodeLabel} were kept on this phone.</div>}
      <div className="breaker-capture-slots">
        {SIDES.map(({ side, label, hint }) => {
          const shot = shots[side];
          return (
            <label key={side} className={`breaker-slot${shot ? ' breaker-slot--taken' : ''}`}>
              {/* capture="environment" opens the rear camera directly on phones. */}
              <input
                type="file"
                accept="image/*"
                capture="environment"
                disabled={saving || reading !== null}
                onChange={e => {
                  void take(side, e.target.files?.[0]);
                  e.target.value = '';
                }}
              />
              {shot ? (
                <img src={shot.url} alt={`${label} of ${nodeLabel}`} />
              ) : (
                <span className="breaker-slot-empty" aria-hidden="true">📷</span>
              )}
              <span className="breaker-slot-label">
                {reading === side ? 'Reading…' : shot ? `${label} ✓ · Retake` : `${label} photo`}
              </span>
              {!shot && <span className="breaker-slot-hint">{hint}</span>}
            </label>
          );
        })}
      </div>
      {error && <div className="alert alert-error">{error}</div>}
      <div className="breaker-capture-actions">
        <button
          type="button"
          className="btn btn-primary breaker-save"
          disabled={!ready || saving}
          onClick={() => onSave([shots.front!, shots.back!], { captureSeconds: Math.round((Date.now() - startedAt.current) / 1000) })}
        >
          {saving ? 'Saving…' : ready ? 'Save Breaker with photos' : `Take the ${shots.front ? 'back' : 'front'} photo`}
        </button>
        <div className="breaker-capture-secondary">
          <button type="button" className="btn btn-secondary" onClick={onBack} disabled={saving}>
            Back
          </button>
          <button type="button" className="btn btn-secondary" onClick={onManual} disabled={saving}>
            Record without photos
          </button>
        </div>
        {(shots.front || shots.back) && (
          <button type="button" className="breaker-discard" onClick={() => void discard()} disabled={saving}>
            Discard these photos
          </button>
        )}
      </div>
    </div>
  );
}
