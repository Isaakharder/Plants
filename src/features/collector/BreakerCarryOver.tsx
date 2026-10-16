// Friday walkthrough (Breakers only): a node whose latest record is a Breaker
// from an earlier week. If the pepper is still on the plant, "Still Breaker"
// records it again for this week on the same node, in one tap and without
// photos; new front/back photos are optional. Its earlier record and photos
// (with their dates) stay as they are. A pepper is never recorded twice in
// one week: once recorded, the node shows "Breaker already recorded".

import type { LatestNodeStatus } from './types';
import { useRecordedBreakerPhotos } from './api';
import { Side } from './BreakerRecorded';
import { photosInEffect } from './photos';

export function BreakerCarryOver({
  userId,
  nodeLabel,
  previous,
  saving,
  onStillBreaker,
  onStillBreakerWithPhotos,
  onChangeStatus,
}: {
  userId: string;
  nodeLabel: string;
  /** The node's latest record: a Breaker from an earlier week. */
  previous: LatestNodeStatus;
  saving: boolean;
  onStillBreaker: () => void;
  /** Absent when Breaker photos are switched off. */
  onStillBreakerWithPhotos?: () => void;
  onChangeStatus: () => void;
}) {
  const { photos, loading } = useRecordedBreakerPhotos(userId, previous.id);
  const sides = photosInEffect(photos);
  const hasPhotos = Boolean(sides.front.current || sides.back.current);
  return (
    <div className="breaker-recorded">
      <p className="breaker-carry-head" role="status">
        Breaker since W{previous.week_number}
        <span>Is the pepper on {nodeLabel} still on the plant? Record it again for this week. It is counted once.</span>
      </p>
      <button type="button" className="btn btn-primary breaker-save" disabled={saving} onClick={onStillBreaker}>
        {saving ? 'Saving…' : '✓ Still Breaker'}
      </button>
      <div className="breaker-capture-secondary">
        {onStillBreakerWithPhotos && (
          <button type="button" className="btn btn-secondary" disabled={saving} onClick={onStillBreakerWithPhotos}>
            Still Breaker + new photos
          </button>
        )}
        <button type="button" className="btn btn-secondary" disabled={saving} onClick={onChangeStatus}>
          Change status
        </button>
      </div>
      {!loading && hasPhotos && (
        <>
          <p className="breaker-recorded-note">Photos from W{previous.week_number} (kept with that record):</p>
          <div className="breaker-recorded-photos">
            <Side label="Front" photo={sides.front.current} replacedCount={0} />
            <Side label="Back" photo={sides.back.current} replacedCount={0} />
          </div>
        </>
      )}
      <p className="breaker-recorded-note">If it was picked or is gone, choose Change status, or leave it: a Breaker not recorded again isn’t counted next week.</p>
    </div>
  );
}
