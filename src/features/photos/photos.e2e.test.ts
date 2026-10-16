// Breaker photos end to end against a LOCAL stack only (local Postgres +
// PostgREST + the preview server's Storage stand-in): the phone's sync step,
// the viewer's reads, colour estimates and node corrections. Skipped unless
// VITE_E2E_URL points at localhost.
//
//   VITE_E2E_URL=http://localhost:5181 VITE_E2E_ANON=… VITE_E2E_TOKEN=… npx vitest run src/features/photos/photos.e2e.test.ts

import { createClient } from '@supabase/supabase-js'
import { describe, expect, it, vi } from 'vitest'
import type { Database } from '../../lib/database.types'

const env = import.meta.env as Record<string, string | undefined>
const URL_ = env.VITE_E2E_URL
const local = Boolean(URL_ && /^http:\/\/(localhost|127\.0\.0\.1)[:/]/.test(URL_))

vi.mock('../../lib/supabase', () => {
  const e = import.meta.env as Record<string, string | undefined>
  return { supabase: createClient(e.VITE_E2E_URL ?? 'http://localhost:1', e.VITE_E2E_ANON ?? 'x', { accessToken: async () => e.VITE_E2E_TOKEN ?? '' }) }
})

describe.skipIf(!local)('Breaker photos against the local stack', () => {
  it('uploads front (with preview) and back privately, never duplicates, and corrections only add rows', { timeout: 60_000 }, async () => {
    const { supabase } = await import('../../lib/supabase')
    const db = supabase as unknown as ReturnType<typeof createClient<Database>>
    const { PHOTO_BUCKET, sendPhoto } = await import('../collector/offline/photoUpload')
    const { photoPath, previewPath, sha256Hex } = await import('../collector/photos')
    const { addColourEstimate, addPairCorrection } = await import('./api')
    const { buildPairs } = await import('./model')
    const uploader = {
      upload: (path: string, body: ArrayBuffer, contentType: string) => db.storage.from(PHOTO_BUCKET).upload(path, body, { contentType, upsert: false }),
      insertRecord: async (record: Record<string, unknown>) => {
        const res = await db.from('node_photos').upsert(record as never, { onConflict: 'id', ignoreDuplicates: true })
        return { error: res.error, status: res.status }
      },
    }

    const crop = (await db.from('crops').select('*').eq('name', 'Mathieu').single()).data!
    const [node, other] = (await db.from('plant_nodes').select('*').eq('crop_id', crop.id).eq('is_active', true).eq('is_side_shoot', false).order('id').limit(2)).data!
    const obsId = crypto.randomUUID()
    expect((await db.from('node_observations').insert({ id: obsId, organization_id: crop.organization_id, crop_id: crop.id, plant_node_id: node.id, year: 2026, week_number: 42, status: 'BreakerFruit', observed_at: new Date().toISOString() })).error).toBeNull()

    for (const side of ['front', 'back'] as const) {
      const bytes = new TextEncoder().encode(`original ${side} ${obsId}`)
      const id = crypto.randomUUID()
      const preview = side === 'front' ? new Blob([new TextEncoder().encode(`preview ${obsId}`)], { type: 'image/jpeg' }) : null
      const record = {
        id, organization_id: crop.organization_id, crop_id: crop.id, plant_node_id: node.id, node_observation_id: obsId, side,
        storage_path: photoPath(crop.organization_id, crop.id, node.id, id, 'image/jpeg'),
        preview_path: preview ? previewPath(crop.organization_id, crop.id, node.id, id) : null,
        content_type: 'image/jpeg', bytes: bytes.length, sha256: await sha256Hex(bytes.buffer as ArrayBuffer), taken_at: new Date().toISOString(),
        capture_meta: { source: 'camera', collector: 'e2e' },
      }
      const image = new Blob([bytes], { type: 'image/jpeg' })
      expect(await sendPhoto(uploader, record, image, preview)).toEqual({ ok: true })
      expect(await sendPhoto(uploader, record, image, preview)).toEqual({ ok: true }) // retried: no duplicate
      expect(await (await db.storage.from(PHOTO_BUCKET).download(record.storage_path)).data!.text()).toBe(`original ${side} ${obsId}`)
      if (preview) expect(await (await db.storage.from(PHOTO_BUCKET).download(record.preview_path!)).data!.text()).toBe(`preview ${obsId}`)
      expect((await fetch(`${URL_}/storage/v1/object/${PHOTO_BUCKET}/${record.storage_path}`)).status).toBe(403) // no public access
    }

    const load = async () => {
      const photos = (await db.from('node_photos').select('*').eq('node_observation_id', obsId)).data!
      const analyses = (await db.from('photo_colour_analyses').select('*').eq('node_observation_id', obsId)).data!
      const corrections = (await db.from('photo_pair_corrections').select('*').eq('node_observation_id', obsId)).data!
      const stems = (await db.from('measurement_stems').select('id, stem_name, measurement_row_id').eq('crop_id', crop.id)).data!
      const rows = (await db.from('measurement_rows').select('id, row_name').eq('crop_id', crop.id)).data!
      return buildPairs({
        photos, analyses, corrections,
        stems: new Map(stems.map((s) => [s.id, { name: s.stem_name, rowId: s.measurement_row_id }])),
        rows: new Map(rows.map((r) => [r.id, r.row_name])),
        nodes: new Map([[other.id, { id: other.id, stemId: other.measurement_stem_id, nodeNumber: other.node_number, label: other.node_label, isSideShoot: other.is_side_shoot }]]),
      })[0]
    }
    let pair = await load()
    expect(pair.front?.preview_path).toBeTruthy()
    expect(pair.back?.preview_path).toBeNull()
    expect(pair.atCapture.nodeName).toBe(`Node ${node.node_number}`)

    await addColourEstimate(pair, { front: 30, back: 10, combined: 20, note: null })
    pair = await load()
    await addColourEstimate(pair, { front: 30, back: 20, combined: 25, note: 'back was shaded' })
    pair = await load()
    expect(pair.colour).toMatchObject({ kind: 'correction', combined_percent: 25 })
    expect(pair.colourHistory).toHaveLength(2)

    const observationsBefore = (await db.from('node_observations').select('id', { count: 'exact', head: true }).eq('crop_id', crop.id)).count
    await addPairCorrection(pair, 'reassign_node', other.id, 'next node')
    pair = await load()
    expect(pair.assignment.kind).toBe('reassign_node')
    // Reassigning added no observation (no false stage change) and kept the photos where they were recorded.
    expect((await db.from('node_observations').select('id', { count: 'exact', head: true }).eq('crop_id', crop.id)).count).toBe(observationsBefore)
    expect((await db.from('node_photos').select('plant_node_id').eq('node_observation_id', obsId)).data!.every((p) => p.plant_node_id === node.id)).toBe(true)
    await addPairCorrection(pair, 'restore', null, null)
    expect((await load()).assignment.kind).toBe('as_captured')
  })
})
