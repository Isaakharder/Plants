import { describe, expect, it } from 'vitest'
import { OfflineQueue, memoryStorage, type QueuedWrite, type WriteResult } from './offlineQueue'
import { sendPhoto, type PhotoUploader } from './photoUpload'

const record = { id: 'p1', storage_path: 'org/crop/node/p1.jpg', content_type: 'image/jpeg' }
const image = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' })

function fakeUploader(opts: { upload?: { message: string; status?: number; statusCode?: string } | null; insert?: { message: string } | null; insertStatus?: number } = {}) {
  const calls: string[] = []
  const stored = new Map<string, ArrayBuffer>()
  const rows = new Map<string, unknown>()
  const uploader: PhotoUploader = {
    upload: async (path, body) => {
      calls.push('upload')
      if (opts.upload) return { error: opts.upload }
      if (stored.has(path)) return { error: { message: 'The resource already exists', statusCode: '409', status: 400 } }
      stored.set(path, body)
      return { error: null }
    },
    insertRecord: async (r) => {
      calls.push('insert')
      if (opts.insert) return { error: opts.insert, status: opts.insertStatus ?? 400 }
      if (!rows.has(String(r.id))) rows.set(String(r.id), r)
      return { error: null, status: 201 }
    },
  }
  return { uploader, calls, stored, rows }
}

describe('sendPhoto', () => {
  it('stores the image first, then its record', async () => {
    const f = fakeUploader()
    expect(await sendPhoto(f.uploader, record, image)).toEqual({ ok: true })
    expect(f.calls).toEqual(['upload', 'insert'])
    expect(new Uint8Array(f.stored.get(record.storage_path)!)).toEqual(new Uint8Array([1, 2, 3]))
  })

  it('a retry after a lost response finds the image already stored and makes no second record', async () => {
    const f = fakeUploader()
    await sendPhoto(f.uploader, record, image)
    expect(await sendPhoto(f.uploader, record, image)).toEqual({ ok: true })
    expect(f.stored.size).toBe(1)
    expect(f.rows.size).toBe(1)
  })

  it('never stores the record when the image didn’t upload; network and server errors retry, refusals don’t', async () => {
    const offline = fakeUploader({ upload: { message: 'Failed to fetch', status: 0 } })
    expect(await sendPhoto(offline.uploader, record, image)).toMatchObject({ ok: false, retryable: true })
    expect(offline.calls).toEqual(['upload'])
    const refused = fakeUploader({ upload: { message: 'new row violates row-level security policy', status: 403 } })
    expect(await sendPhoto(refused.uploader, record, image)).toMatchObject({ ok: false, retryable: false })
    const server = fakeUploader({ upload: { message: 'Internal error', status: 503 } })
    expect(await sendPhoto(server.uploader, record, image)).toMatchObject({ ok: false, retryable: true })
  })

  it('a record that fails on the server is retried; one that is refused is kept as failed', async () => {
    expect(await sendPhoto(fakeUploader({ insert: { message: 'timeout' }, insertStatus: 503 }).uploader, record, image)).toMatchObject({ ok: false, retryable: true })
    expect(await sendPhoto(fakeUploader({ insert: { message: 'Photos document BreakerFruit records only' }, insertStatus: 400 }).uploader, record, image)).toMatchObject({
      ok: false,
      retryable: false,
    })
  })
})

describe('sendPhoto with a preview', () => {
  const withPreview = { ...record, preview_path: 'org/crop/node/p1.preview.jpg' }
  const small = new Blob([new Uint8Array([9])], { type: 'image/jpeg' })

  it('stores original, then preview, then the record', async () => {
    const f = fakeUploader()
    expect(await sendPhoto(f.uploader, withPreview, image, small)).toEqual({ ok: true })
    expect(f.calls).toEqual(['upload', 'upload', 'insert'])
    expect([...f.stored.keys()]).toEqual([record.storage_path, withPreview.preview_path])
    expect(f.rows.get('p1')).toMatchObject({ preview_path: withPreview.preview_path })
  })

  it('a refused preview is dropped from the record instead of blocking the photo; a delayed one is retried', async () => {
    let n = 0
    const refusing: PhotoUploader = {
      upload: async () => (++n === 2 ? { error: { message: 'mime type not allowed', status: 415 } } : { error: null }),
      insertRecord: async (r) => {
        expect(r.preview_path).toBeNull()
        return { error: null, status: 201 }
      },
    }
    expect(await sendPhoto(refusing, withPreview, image, small)).toEqual({ ok: true })
    let m = 0
    const delayed: PhotoUploader = {
      upload: async () => (++m === 2 ? { error: { message: 'Bad gateway', status: 502 } } : { error: null }),
      insertRecord: async () => {
        throw new Error('the record must wait for the preview')
      },
    }
    expect(await sendPhoto(delayed, withPreview, image, small)).toMatchObject({ ok: false, retryable: true })
  })
})

describe('photos in the offline queue', () => {
  const status: QueuedWrite = {
    type: 'record_status',
    record: { id: 'o1', organization_id: 'org', crop_id: 'crop', plant_node_id: 'n1', year: 2026, week_number: 42, status: 'BreakerFruit', observed_at: '2026-10-16T14:00:00Z' },
  }
  const photo = (id: string, side: 'front' | 'back'): QueuedWrite => ({
    type: 'upload_photo',
    image,
    preview: null,
    record: {
      id, organization_id: 'org', crop_id: 'crop', plant_node_id: 'n1', node_observation_id: 'o1', side,
      storage_path: `org/crop/n1/${id}.jpg`, content_type: 'image/jpeg', bytes: 3, sha256: 'a'.repeat(64), taken_at: '2026-10-16T14:00:05Z',
    },
  })

  it('keeps the image with the queued write and sends it after its observation, in order', async () => {
    let n = 0
    const queue = new OfflineQueue(memoryStorage(), () => `q${++n}`)
    await queue.enqueue(status, 'u')
    await queue.enqueue(photo('p1', 'front'), 'u')
    await queue.enqueue(photo('p2', 'back'), 'u')
    const stored = queue.list('u').find((a) => a.type === 'upload_photo')!
    expect(stored.type === 'upload_photo' && stored.image.size).toBe(3)

    const sent: string[] = []
    // Offline at the first photo: the run stops there and nothing after it is sent.
    let online = false
    const execute = async (w: QueuedWrite): Promise<WriteResult> => {
      if (w.type === 'upload_photo' && !online) return { ok: false, retryable: true, message: 'offline' }
      sent.push(w.type === 'upload_photo' ? `photo:${w.record.side}` : w.type)
      return { ok: true }
    }
    expect(await queue.sync('u', execute)).toMatchObject({ synced: 1, remaining: 2, interrupted: true })
    online = true
    expect(await queue.sync('u', execute)).toMatchObject({ synced: 2, remaining: 0 })
    expect(sent).toEqual(['record_status', 'photo:front', 'photo:back'])
  })
})

describe('many photos waiting on one phone', () => {
  it('sends 10 Breakers with 20 photos in order across a dropped connection; a refused photo is kept as failed and doesn’t block the rest', async () => {
    let n = 0
    const queue = new OfflineQueue(memoryStorage(), () => `q${++n}`)
    for (let b = 1; b <= 10; b++) {
      await queue.enqueue({ type: 'record_status', record: { id: `o${b}`, organization_id: 'org', crop_id: 'crop', plant_node_id: `n${b}`, year: 2026, week_number: 42, status: 'BreakerFruit', observed_at: '2026-10-16T14:00:00Z' } }, 'u')
      for (const side of ['front', 'back'] as const) {
        await queue.enqueue({
          type: 'upload_photo', image, preview: null,
          record: { id: `p${b}${side}`, organization_id: 'org', crop_id: 'crop', plant_node_id: `n${b}`, node_observation_id: `o${b}`, side, storage_path: `org/crop/n${b}/p${b}${side}.jpg`, content_type: 'image/jpeg', bytes: 3, sha256: 'a'.repeat(64), taken_at: '2026-10-16T14:00:05Z' },
        }, 'u')
      }
    }
    expect(queue.list('u').filter((a) => a.type === 'upload_photo')).toHaveLength(20)

    const sent: string[] = []
    let calls = 0
    const execute = async (w: QueuedWrite): Promise<WriteResult> => {
      calls++
      if (calls === 12) return { ok: false, retryable: true, message: 'Wi-Fi dropped' } // the connection drops mid-way
      if (w.type === 'upload_photo' && w.record.id === 'p7back') return { ok: false, retryable: false, message: 'Photo record: refused' }
      sent.push(String((w.record as { id: string }).id))
      return { ok: true }
    }
    const first = await queue.sync('u', execute)
    expect(first).toMatchObject({ interrupted: true })
    const second = await queue.sync('u', execute)
    expect(second).toMatchObject({ remaining: 0, failed: 1 })
    // Everything except the refused photo was sent, each observation before its photos, in capture order.
    expect(sent).toHaveLength(29)
    for (let b = 1; b <= 10; b++) expect(sent.indexOf(`o${b}`)).toBeLessThan(sent.indexOf(`p${b}front`))
    expect(queue.list('u').filter((a) => a.status === 'failed').map((a) => a.type === 'upload_photo' && a.record.id)).toEqual(['p7back'])
  })
})
