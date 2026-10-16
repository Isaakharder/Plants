import { describe, expect, it } from 'vitest'
import type { PreparedPhoto } from '../photos'
import { DRAFT_MAX_AGE_MS, draftAlreadySaved, draftKey, draftSession, freshDrafts, memoryDrafts, type CaptureDraft, type DraftStorage } from './captureDrafts'

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

  // Staging, 2026-10-16: a back photo still being read when the Breaker was
  // saved wrote the draft back after the save deleted it; "Finish" then
  // recorded the same Breaker a second time.
  it('never writes a draft back after the Breaker is saved', async () => {
    const store = memoryDrafts()
    let release!: () => void
    let started!: () => void
    const writing = new Promise<void>((r) => (started = r))
    const slow: DraftStorage = {
      ...store,
      put: (d) => new Promise<void>((r) => {
        release = () => void store.put(d).then(r)
        started()
      }),
    }
    const key = draftKey('u1', 'n1')
    const draft = (shots: CaptureDraft['shots']): CaptureDraft => ({ key, userId: 'u1', nodeId: 'n1', stemId: 's', startedAt: 1, savedAt: 2, shots })
    const session = draftSession(slow, key)
    const first = session.put(draft({ front: shot('front') }))
    await writing // the front photo's draft is being written…
    const saved = session.end(true) // … when the Breaker is saved
    void session.put(draft({ front: shot('front'), back: shot('back') })) // a photo that finished reading late
    release()
    await first
    await saved
    expect(await store.get(key)).toBeUndefined()
  })

  it('keeps the draft when the photo step is left without saving', async () => {
    const store = memoryDrafts()
    const key = draftKey('u1', 'n1')
    const session = draftSession(store, key)
    await session.put({ key, userId: 'u1', nodeId: 'n1', stemId: 's', startedAt: 1, savedAt: 2, shots: { front: shot('front') } })
    await session.end(false)
    expect((await store.get(key))?.shots.front).toBeDefined()
  })

  it('recognises a leftover draft of a Breaker that was saved', () => {
    const d: CaptureDraft = { key: 'k', userId: 'u1', nodeId: 'n1', stemId: 's', startedAt: Date.parse('2026-10-16T16:12:00Z'), savedAt: 0, shots: {} }
    expect(draftAlreadySaved(d, { status: 'BreakerFruit', observed_at: '2026-10-16T16:12:40Z' })).toBe(true)
    expect(draftAlreadySaved(d, { status: 'BreakerFruit', observed_at: '2026-10-09T10:00:00Z' })).toBe(false) // last week's Breaker
    expect(draftAlreadySaved(d, { status: 'MatureGreen', observed_at: '2026-10-16T16:12:40Z' })).toBe(false)
    expect(draftAlreadySaved({ ...d, replacing: { observationId: 'o1' } }, { status: 'BreakerFruit', observed_at: '2026-10-16T16:12:40Z' })).toBe(false)
  })
})
