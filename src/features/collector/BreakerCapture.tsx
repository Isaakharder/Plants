// Camera-first Breaker recording: the front and the back of the pepper are
// photographed before the Breaker record is saved. "Record without photos"
// keeps the manual workflow available at any time.
//
// Every photo taken is kept on the phone as a draft at once, so a reload
// (phones may reload the page while the camera is open or the screen is
// locked) never loses it: reopening this node's Breaker step restores it.
//
// The same step replaces the photos of a Breaker already recorded: the new
// photos join that record (never a second Breaker), each naming the photo it
// replaces, and the earlier photos stay stored.
//
// Staging, 2026-10-16: a tap on a taken photo reopened the camera, Save was
// pressed while that photo was still being read, and the late photo brought
// the draft back after the save; "Finish" then recorded the Breaker twice.
// Now a taken photo is only retaken with its Retake button, Save waits for
// photos being read, and nothing is written to the draft after a save.

import { useEffect, useRef, useState } from 'react';
import type { PhotoSide } from '../../lib/database.types';
import { captureDrafts, draftKey, draftSession, type CaptureDraft, type DraftSession } from './offline/captureDrafts';
import { PHOTO_GUIDANCE, preparePhoto, requestPersistentStorage, type PreparedPhoto } from './photos';

type Shot = PreparedPhoto & { url: string };

export type CaptureMode =
  | { kind: 'new' }
  /** New photos for the Breaker recorded as observationId; hasPhotos false: it was recorded without photos. */
  | { kind: 'replace'; observationId: string; recordedAt: string; hasPhotos: boolean };

export const REPLACE_REASONS = [
  'Blurred or unclear',
  'Wrong pepper photographed',
  'Pepper hidden (leaves, hands)',
  'Other',
] as const;

const SIDES: { side: PhotoSide; label: string; hint: string }[] = [
  { side: 'front', label: 'Front', hint: 'The side facing the aisle' },
  { side: 'back', label: 'Back', hint: 'Turn the pepper gently, or shoot from behind' },
];

const time = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

export function BreakerCapture({
  userId,
  nodeId,
  stemId,
  nodeLabel,
  mode,
  saving,
  onSave,
  onManual,
  onBack,
}: {
  userId: string;
  nodeId: string;
  stemId: string;
  nodeLabel: string;
  mode: CaptureMode;
  saving: boolean;
  /**
   * captureSeconds: from first opening the photo step (across reloads) to
   * saving. reason: why photos are replaced (replace mode). Resolves true
   * once saved; the draft is deleted only then.
   */
  onSave: (photos: PreparedPhoto[], meta: { captureSeconds: number; reason: string | null }) => Promise<boolean>;
  onManual: () => void;
  onBack: () => void;
}) {
  const [shots, setShots] = useState<Partial<Record<PhotoSide, Shot>>>({});
  const [error, setError] = useState('');
  const [reading, setReading] = useState<PhotoSide | null>(null);
  const [restored, setRestored] = useState(false);
  const [reason, setReason] = useState('');
  const urls = useRef<string[]>([]);
  const startedAt = useRef(0);
  const inputs = useRef<Partial<Record<PhotoSide, HTMLInputElement | null>>>({});
  const key = draftKey(userId, nodeId);
  const replacing = mode.kind === 'replace' ? mode.observationId : null;
  const session = useRef<DraftSession | null>(null);

  const withUrl = (p: PreparedPhoto): Shot => {
    const url = URL.createObjectURL(p.preview ?? p.image);
    urls.current.push(url);
    return { ...p, url };
  };

  // Restore photos taken before a reload (of this same step: a new Breaker,
  // or replacing this record's photos); keep stored data safe; free previews on close.
  useEffect(() => {
    const own = draftSession(captureDrafts(), key);
    session.current = own;
    startedAt.current = Date.now();
    requestPersistentStorage();
    void captureDrafts()
      .get(key)
      .then(draft => {
        if (own.ended || !draft || Object.keys(draft.shots).length === 0) return;
        if ((draft.replacing?.observationId ?? null) !== replacing) return;
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
      // Leaving without saving keeps the draft; no late photo is written after this.
      void own.end(false);
      created.forEach(u => URL.revokeObjectURL(u));
    };
    // withUrl only touches the ref; restoring once per node is intended.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, replacing]);

  async function take(side: PhotoSide, file: File | undefined) {
    const own = session.current;
    if (!file || !own || own.ended) return;
    setError('');
    setReading(side);
    try {
      const photo = await preparePhoto(side, file);
      // Saved or closed while this photo was being read: it belongs to nothing.
      if (own.ended) return;
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
      await own.put({
        key, userId, nodeId, stemId, startedAt: startedAt.current, savedAt: Date.now(), shots: stored,
        ...(replacing ? { replacing: { observationId: replacing } } : {}),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setReading(null);
    }
  }

  async function discard() {
    await session.current?.remove().catch(() => {});
    setShots({});
    setRestored(false);
    startedAt.current = Date.now();
  }

  async function save() {
    const own = session.current;
    if (!own || own.ended) return;
    const photos = (['front', 'back'] as PhotoSide[]).flatMap(s => (shots[s] ? [shots[s]!] : []));
    const ok = await onSave(photos, {
      captureSeconds: Math.round((Date.now() - startedAt.current) / 1000),
      reason: mode.kind === 'replace' ? (mode.hasPhotos ? reason : 'Added photos') : null,
    });
    if (ok) await own.end(true).catch(() => {});
  }

  const taken = (shots.front ? 1 : 0) + (shots.back ? 1 : 0);
  const ready =
    reading === null &&
    (mode.kind === 'new' ? taken === 2 : taken > 0 && (!mode.hasPhotos || reason !== ''));
  const saveLabel = saving
    ? 'Saving…'
    : reading
      ? 'Reading the photo…'
      : mode.kind === 'replace'
        ? taken === 0
          ? 'Take a new photo'
          : mode.hasPhotos && !reason
            ? 'Choose why you replace them'
            : mode.hasPhotos ? `Save ${taken === 1 ? 'replacement photo' : 'replacement photos'}` : `Add ${taken === 1 ? 'photo' : 'photos'}`
        : ready
          ? 'Save Breaker with photos'
          : `Take the ${shots.front ? 'back' : 'front'} photo`;

  return (
    <div className="breaker-capture">
      {mode.kind === 'replace' ? (
        <p className="breaker-capture-intro">
          <strong>{nodeLabel}</strong>: {mode.hasPhotos ? 'replacing the photos' : 'adding photos to the Breaker'} recorded at {time(mode.recordedAt)}.
          {mode.hasPhotos ? ' Retake only the side that needs it. The earlier photos are kept for the record.' : ''} The Breaker stays recorded once.
        </p>
      ) : (
        <p className="breaker-capture-intro">
          <strong>{nodeLabel}</strong>: photograph the front, then the back.
        </p>
      )}
      <p className="breaker-capture-guidance">{PHOTO_GUIDANCE}</p>
      {restored && <div className="alert alert-info">The photos you took earlier for {nodeLabel} were kept on this phone. They are not saved yet.</div>}
      <div className="breaker-capture-slots">
        {SIDES.map(({ side, label, hint }) => {
          const shot = shots[side];
          // capture="environment" opens the rear camera directly on phones.
          const input = (
            <input
              ref={el => { inputs.current[side] = el; }}
              type="file"
              accept="image/*"
              capture="environment"
              disabled={saving || reading !== null}
              onChange={e => {
                void take(side, e.target.files?.[0]);
                e.target.value = '';
              }}
            />
          );
          // A taken photo is not a camera button: only its Retake button reopens the camera.
          return shot ? (
            <div key={side} className="breaker-slot breaker-slot--taken">
              <img src={shot.url} alt={`${label} of ${nodeLabel}`} />
              <span className="breaker-slot-label">{reading === side ? 'Reading…' : `${label} ✓`}</span>
              <button
                type="button"
                className="btn btn-secondary btn-sm breaker-retake"
                disabled={saving || reading !== null}
                onClick={() => inputs.current[side]?.click()}
              >
                Retake {label.toLowerCase()}
              </button>
              <span className="breaker-slot-hidden-input">{input}</span>
            </div>
          ) : (
            <label key={side} className="breaker-slot">
              {input}
              <span className="breaker-slot-empty" aria-hidden="true">📷</span>
              <span className="breaker-slot-label">{reading === side ? 'Reading…' : `${mode.kind === 'replace' ? 'New ' + label.toLowerCase() : label} photo`}</span>
              {reading !== side && <span className="breaker-slot-hint">{mode.kind === 'replace' && mode.hasPhotos ? 'Optional: only if it needs replacing' : hint}</span>}
            </label>
          );
        })}
      </div>
      {mode.kind === 'replace' && mode.hasPhotos && (
        <label className="form-group breaker-reason">
          <span className="form-label">Why are you replacing them?</span>
          <select className="form-control mobile-control" value={reason} onChange={e => setReason(e.target.value)} disabled={saving}>
            <option value="">Choose…</option>
            {REPLACE_REASONS.map(r => (
              <option key={r} value={r}>{r}</option>
            ))}
          </select>
        </label>
      )}
      {error && <div className="alert alert-error">{error}</div>}
      <div className="breaker-capture-actions">
        <button type="button" className="btn btn-primary breaker-save" disabled={!ready || saving} onClick={() => void save()}>
          {saveLabel}
        </button>
        <div className="breaker-capture-secondary">
          <button type="button" className="btn btn-secondary" onClick={onBack} disabled={saving}>
            Back
          </button>
          {mode.kind === 'new' && (
            <button type="button" className="btn btn-secondary" onClick={onManual} disabled={saving || reading !== null}>
              Record without photos
            </button>
          )}
        </div>
        {(shots.front || shots.back) && (
          <button type="button" className="breaker-discard" onClick={() => void discard()} disabled={saving || reading !== null}>
            Discard these photos
          </button>
        )}
      </div>
    </div>
  );
}
