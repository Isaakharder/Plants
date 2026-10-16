// Shown instead of the camera when a node already has a Breaker recorded this
// greenhouse week: what was saved, whether its photos are uploaded or still
// on this phone, and, deliberately, only one way to change the photos:
// "Replace photos", which adds photos to that same record. A second Breaker
// record of the same pepper can't be started from here.

import { useEffect, useState } from 'react';
import type { PhotoSide } from '../../lib/database.types';
import { supabase } from '../../lib/supabase';
import { useRecordedBreakerPhotos, type RecordedPhoto } from './api';
import { PHOTO_BUCKET } from './offline/photoUpload';
import { photosInEffect } from './photos';
import type { LatestNodeStatus } from './types';

const time = (iso: string) => new Date(iso).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });

/** The photo's preview: from this phone while it waits to upload, else from the private bucket. */
function usePreview(photo: RecordedPhoto | null) {
  const [url, setUrl] = useState<string | null>(null);
  const local = photo?.local ?? null;
  const path = photo?.previewPath ?? null;
  useEffect(() => {
    let made: string | null = null;
    let cancelled = false;
    setUrl(null);
    if (local) {
      made = URL.createObjectURL(local);
      setUrl(made);
    } else if (path) {
      void supabase.storage.from(PHOTO_BUCKET).download(path).then(({ data }) => {
        if (cancelled || !data) return;
        made = URL.createObjectURL(data);
        setUrl(made);
      });
    }
    return () => {
      cancelled = true;
      if (made) URL.revokeObjectURL(made);
    };
  }, [local, path]);
  return url;
}

function Side({ label, photo, replacedCount }: { label: string; photo: RecordedPhoto | null; replacedCount: number }) {
  const url = usePreview(photo);
  const state = !photo
    ? 'No photo'
    : photo.state === 'uploaded'
      ? '✓ Uploaded'
      : photo.state === 'failed'
        ? '⚠ Upload failed: see the sync banner'
        : 'On this phone, waiting to upload';
  return (
    <div className="breaker-recorded-photo">
      {photo && url ? <img src={url} alt={`${label} photo`} /> : <div className="breaker-recorded-missing">{photo ? '…' : 'No photo'}</div>}
      <strong>{label}</strong>
      <span>{state}</span>
      {replacedCount > 0 && <span className="breaker-recorded-note">Replaced {replacedCount}× (earlier photo kept)</span>}
    </div>
  );
}

export function BreakerRecorded({
  userId,
  nodeLabel,
  observation,
  onReplace,
  onChangeStatus,
  onDone,
}: {
  userId: string;
  nodeLabel: string;
  observation: LatestNodeStatus;
  /** hasPhotos false: the Breaker was recorded without photos, so photos are added. */
  onReplace: (current: Partial<Record<PhotoSide, string>>, hasPhotos: boolean) => void;
  onChangeStatus: () => void;
  onDone: () => void;
}) {
  const { photos, loading, serverChecked } = useRecordedBreakerPhotos(userId, observation.id);
  const sides = photosInEffect(photos);
  const hasPhotos = Boolean(sides.front.current || sides.back.current);
  const current: Partial<Record<PhotoSide, string>> = {};
  if (sides.front.current) current.front = sides.front.current.id;
  if (sides.back.current) current.back = sides.back.current.id;
  // Offline, with nothing waiting here: the uploaded photos can't be checked, so don't claim there are none.
  const unknown = !serverChecked && !loading && !hasPhotos;

  return (
    <div className="breaker-recorded">
      <p className="breaker-recorded-head" role="status">
        ✓ Breaker already recorded for {nodeLabel} this week
        <span>Saved {time(observation.observed_at)}. Nothing more is needed for this pepper.</span>
      </p>
      {loading ? (
        <p className="breaker-recorded-note">Checking its photos…</p>
      ) : unknown ? (
        <p className="breaker-recorded-note">Its uploaded photos can’t be shown offline. Reconnect to see them.</p>
      ) : (
        <div className="breaker-recorded-photos">
          <Side label="Front" photo={sides.front.current} replacedCount={sides.front.replaced.length} />
          <Side label="Back" photo={sides.back.current} replacedCount={sides.back.replaced.length} />
        </div>
      )}
      <button type="button" className="btn btn-primary breaker-save" onClick={onDone}>
        Done
      </button>
      <div className="breaker-capture-secondary">
        {/* Offline the uploaded photos are unknown: treat it as replacing (a reason is asked; the newest photo of a side is the one used). */}
        <button type="button" className="btn btn-secondary" disabled={loading} onClick={() => onReplace(current, hasPhotos || unknown)}>
          {hasPhotos || unknown ? 'Replace photos' : 'Add photos'}
        </button>
        <button type="button" className="btn btn-secondary" onClick={onChangeStatus}>
          Change status
        </button>
      </div>
      {(hasPhotos || unknown) && (
        <p className="breaker-recorded-note">
          Replace photos only if they are unclear or show the wrong pepper. The new photos are added to this same Breaker; the earlier ones are kept.
        </p>
      )}
    </div>
  );
}
