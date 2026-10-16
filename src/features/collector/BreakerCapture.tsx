// Camera-first Breaker recording: the front and the back of the pepper are
// photographed before the Breaker record is saved. "Record without photos"
// keeps the manual workflow available at any time.

import { useEffect, useRef, useState } from 'react';
import type { PhotoSide } from '../../lib/database.types';
import { preparePhoto, type PreparedPhoto } from './photos';

type Shot = PreparedPhoto & { url: string };

const SIDES: { side: PhotoSide; label: string; hint: string }[] = [
  { side: 'front', label: 'Front', hint: 'The side facing the aisle' },
  { side: 'back', label: 'Back', hint: 'Turn the pepper gently, or shoot from behind' },
];

export function BreakerCapture({
  nodeLabel,
  saving,
  onSave,
  onManual,
  onBack,
}: {
  nodeLabel: string;
  saving: boolean;
  onSave: (photos: PreparedPhoto[]) => void;
  onManual: () => void;
  onBack: () => void;
}) {
  const [shots, setShots] = useState<Partial<Record<PhotoSide, Shot>>>({});
  const [error, setError] = useState('');
  const [reading, setReading] = useState<PhotoSide | null>(null);
  const urls = useRef<string[]>([]);

  // Release the previews' memory when the panel closes.
  useEffect(() => () => urls.current.forEach(u => URL.revokeObjectURL(u)), []);

  async function take(side: PhotoSide, file: File | undefined) {
    if (!file) return;
    setError('');
    setReading(side);
    try {
      const photo = await preparePhoto(side, file);
      const url = URL.createObjectURL(file);
      urls.current.push(url);
      setShots(s => ({ ...s, [side]: { ...photo, url } }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setReading(null);
    }
  }

  const ready = Boolean(shots.front && shots.back);

  return (
    <div className="breaker-capture">
      <p className="breaker-capture-intro">
        Photograph <strong>{nodeLabel}</strong>: the front, then the back. Fill the frame with the pepper, avoid direct sun and keep the
        whole fruit in view.
      </p>
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
        <button type="button" className="btn btn-primary breaker-save" disabled={!ready || saving} onClick={() => onSave([shots.front!, shots.back!])}>
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
      </div>
    </div>
  );
}
