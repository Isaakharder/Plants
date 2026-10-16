// Breaker photos end to end against the LOCAL stack only (local Postgres +
// PostgREST + the preview server's Storage stand-in). Skipped unless
// E2E_LOCAL_URL points at localhost.

import { createClient } from '@supabase/supabase-js'
import { describe, expect, it } from 'vitest'
import type { Database } from '../../lib/database.types'
import { PHOTO_BUCKET, sendPhoto, type PhotoUploader } from './offline/photoUpload'
import { photoPath, sha256Hex } from './photos'

const URL_ = process.env.E2E_LOCAL_URL
const local = Boolean(URL_ && /^http:\/\/(localhost|127\.0\.0\.1)[:/]/.test(URL_))

describe.skipIf(!local)('Breaker photos against the local stack', () => {
  it('uploads front and back privately, ties them to the observation, and never duplicates on retry', { timeout: 60_000 }, async () => {
    const db = createClient<Database>(URL_!, process.env.E2E_ANON!, { accessToken: async () => process.env.E2E_TOKEN! })
    const uploader: PhotoUploader = {
      upload: (path, body, contentType) => db.storage.from(PHOTO_BUCKET).upload(path, body, { contentType, upsert: false }),
      insertRecord: async (record) => {
        const res = await db.from('node_photos').upsert(record as never, { onConflict: 'id', ignoreDuplicates: true })
        return { error: res.error, status: res.status }
      },
    }
    const crop = (await db.from('crops').select('*').eq('name', 'Mathieu').single()).data!
    const node = (await db.from('plant_nodes').select('*').eq('crop_id', crop.id).eq('is_active', true).order('id').limit(1).single()).data!
    const obsId = crypto.randomUUID()
    const obs = await db.from('node_observations').insert({ id: obsId, organization_id: crop.organization_id, crop_id: crop.id, plant_node_id: node.id, year: 2026, week_number: 42, status: 'BreakerFruit', observed_at: new Date().toISOString() })
    expect(obs.error).toBeNull()

    const ids: string[] = []
    for (const side of ['front', 'back'] as const) {
      const bytes = new TextEncoder().encode(`fake jpeg ${side} ${obsId}`)
      const id = crypto.randomUUID()
      ids.push(id)
      const record = {
        id, organization_id: crop.organization_id, crop_id: crop.id, plant_node_id: node.id, node_observation_id: obsId, side,
        storage_path: photoPath(crop.organization_id, crop.id, node.id, id, 'image/jpeg'), content_type: 'image/jpeg', bytes: bytes.length,
        sha256: await sha256Hex(bytes.buffer as ArrayBuffer), taken_at: new Date().toISOString(),
      }
      const image = new Blob([bytes], { type: 'image/jpeg' })
      expect(await sendPhoto(uploader, record, image)).toEqual({ ok: true })
      // Retried after a "lost" response: still one object, one record.
      expect(await sendPhoto(uploader, record, image)).toEqual({ ok: true })

      // Readable with the user's session, and through a short-lived signed URL; never public.
      const dl = await db.storage.from(PHOTO_BUCKET).download(record.storage_path)
      expect(await dl.data!.text()).toBe(`fake jpeg ${side} ${obsId}`)
      const signed = await db.storage.from(PHOTO_BUCKET).createSignedUrl(record.storage_path, 60)
      expect((await fetch(signed.data!.signedUrl)).status).toBe(200)
      expect((await fetch(`${URL_}/storage/v1/object/${PHOTO_BUCKET}/${record.storage_path}`)).status).toBe(403)
    }

    const rows = (await db.from('node_photos').select('*').eq('node_observation_id', obsId).order('side')).data!
    expect(rows.map((r) => r.side)).toEqual(['back', 'front'])
    const stem = (await db.from('measurement_stems').select('id, measurement_row_id').eq('id', node.measurement_stem_id).single()).data!
    for (const r of rows) {
      expect(r).toMatchObject({ plant_node_id: node.id, measurement_stem_id: stem.id, measurement_row_id: stem.measurement_row_id, node_number: node.node_number, year: 2026, week_number: 42 })
    }

    // Another organization's folder, and a photo for a non-Breaker record, are refused (not retried).
    const foreign = await db.storage.from(PHOTO_BUCKET).upload(`00000000-0000-4000-8000-000000000000/x/y/z.jpg`, new Uint8Array([1]).buffer, { contentType: 'image/jpeg' })
    expect(foreign.error).not.toBeNull()
    const mg = crypto.randomUUID()
    await db.from('node_observations').insert({ id: mg, organization_id: crop.organization_id, crop_id: crop.id, plant_node_id: node.id, year: 2026, week_number: 42, status: 'MatureGreen', observed_at: new Date().toISOString() })
    const id = crypto.randomUUID()
    const wrong = await sendPhoto(uploader, {
      id, organization_id: crop.organization_id, crop_id: crop.id, plant_node_id: node.id, node_observation_id: mg, side: 'front',
      storage_path: photoPath(crop.organization_id, crop.id, node.id, id, 'image/jpeg'), content_type: 'image/jpeg', bytes: 1, sha256: 'a'.repeat(64), taken_at: new Date().toISOString(),
    }, new Blob([new Uint8Array([1])], { type: 'image/jpeg' }))
    expect(wrong).toMatchObject({ ok: false, retryable: false })
    expect(wrong.ok === false && wrong.message).toMatch(/BreakerFruit records only/)
  })
})
