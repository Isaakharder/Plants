import { describe, expect, it } from 'vitest'
import type { PreparedPhoto } from '../photos'
import { DRAFT_MAX_AGE_MS, draftKey, freshDrafts, memoryDrafts } from './captureDrafts'

const shot = (side: 'front' | 'back'): PreparedPhoto => ({
  side, image: new Blob([new Uint8Array([1])], { type: 'image/jpeg' }), preview: null, contentType: 'image/jpeg', bytes: 1, sha256: 'a'.repeat(64),
  width: null, height: null, takenAt: '2026-10-16T14:00:00Z', captureMeta: {},
})

describe('capture drafts', () => {
  it('keeps photos taken before a reload, per user and node, and drops stale ones', async () => {
    const store = memoryDrafts()
    const now = Date.now()
    await store.put({ key: draftKey('u1', 'n12'), userId: 'u1', nodeId: 'n12', stemId: 's', startedAt: now - 60_000, savedAt: now - 30_000, shots: { front: shot('front') } })
    await store.put({ key: draftKey('u1', 'n13'), userId: 'u1', nodeId: 'n13', stemId: 's', startedAt: 0, savedAt: now - DRAFT_MAX_AGE_MS - 1, shots: { front: shot('front') } })
    await store.put({ key: draftKey('u2', 'n12'), userId: 'u2', nodeId: 'n12', stemId: 's', startedAt: now, savedAt: now, shots: { back: shot('back') } })
    const fresh = await freshDrafts(store, 'u1', now)
    expect(fresh.map((d) => d.nodeId)).toEqual(['n12'])
    expect(fresh[0].shots.front?.image.size).toBe(1)
    expect(await store.get(draftKey('u1', 'n13'))).toBeUndefined() // stale: removed
    expect(await store.get(draftKey('u2', 'n12'))).toBeDefined() // another worker's draft is untouched
  })
})
