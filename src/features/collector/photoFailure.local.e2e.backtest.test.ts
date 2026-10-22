// What happens to a post-harvest inspection when Breaker photos can't be
// uploaded, against the LOCAL stack only (local Postgres + PostgREST + the
// preview server's Storage stand-in), through the collector's own queue and
// sync (executeWrite). Skipped unless E2E_LOCAL_URL points at localhost and
// E2E_STORAGE_DIR names the stand-in's folder (its permissions are changed
// to make uploads fail, then restored).
//
//   E2E_LOCAL_URL=http://localhost:5180 E2E_ANON=… E2E_TOKEN=… E2E_STORAGE_DIR=… \
//     npx vitest run src/features/collector/photoFailure.local.e2e.backtest.test.ts

import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createClient } from '@supabase/supabase-js'
import { describe, expect, it, vi } from 'vitest'
import { addDays, greenhouseToday } from '../harvests/model'
import { OfflineQueue, memoryStorage, type QueuedWrite } from './offline/offlineQueue'
import { photoPath } from './photos'

const URL_ = process.env.E2E_LOCAL_URL
const STORE = process.env.E2E_STORAGE_DIR
const local = Boolean(URL_ && /^http:\/\/(localhost|127\.0\.0\.1)[:/]/.test(URL_) && STORE)
// A real pepper photo from the experimental (staging) dataset.
const JPEG = `${process.env.HOME}/Projects/plants-experimental-photo-dataset-2026-10/images/06103726-ca20-43a1-87b2-d072b6771be0.preview.jpg`

vi.mock('../../lib/supabase', () => ({
  supabase: createClient(process.env.E2E_LOCAL_URL ?? 'http://localhost:1', process.env.E2E_ANON ?? 'x', {
    accessToken: async () => process.env.E2E_TOKEN ?? '',
  }),
}))

describe.skipIf(!local)('Inspection photos that fail to upload (local stack)', () => {
  it('keeps every answer, recovers after a temporary failure without duplicates, and survives a refused photo', { timeout: 90_000 }, async () => {
    const { supabase: db } = await import('../../lib/supabase')
    const { executeWrite } = await import('./offline/networkStatus')
    const check = <R extends { data: unknown; error: { message: string } | null }>(res: R): NonNullable<R['data']> => {
      if (res.error) throw new Error(res.error.message)
      return res.data as NonNullable<R['data']>
    }
    const user: string = JSON.parse(Buffer.from(process.env.E2E_TOKEN!.split('.')[1], 'base64url').toString()).sub
    const crop = check(await db.from('crops').select('*').eq('name', 'Cadalora').single())
    const org = crop.organization_id
    const today = greenhouseToday()
    const week = (iso: string) => {
      const d = new Date(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)))
      d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7))
      const y = d.getUTCFullYear()
      return { year: y, week_number: Math.ceil(((d.getTime() - Date.UTC(y, 0, 1)) / 86_400_000 + 1) / 7) }
    }

    // A fresh row with one stem and three Breakers seen two days ago; harvested yesterday.
    const rowNumber = 700 + Math.floor(Math.random() * 90)
    const row = check(await db.from('measurement_rows').insert({ id: crypto.randomUUID(), organization_id: org, crop_id: crop.id, row_name: `Row ${rowNumber}`, sort_order: 60, is_active: true }).select().single())
    const stem = check(await db.from('measurement_stems').insert({ id: crypto.randomUUID(), organization_id: org, crop_id: crop.id, measurement_row_id: row.id, stem_name: 'Stem 1', sort_order: 1, is_active: true }).select().single())
    const nodes = []
    for (const n of [1, 2, 3]) {
      const node = check(await db.from('plant_nodes').insert({ id: crypto.randomUUID(), organization_id: org, crop_id: crop.id, measurement_stem_id: stem.id, node_number: n, sort_order: n, is_side_shoot: false, parent_node_id: null, node_label: null, side: null, is_active: true, created_at: new Date().toISOString() }).select().single())
      check(await db.from('node_observations').insert({ id: crypto.randomUUID(), organization_id: org, crop_id: crop.id, plant_node_id: node.id, ...week(addDays(today, -2)), status: 'BreakerFruit', observed_at: new Date(Date.now() - 2 * 86_400_000).toISOString() }))
      nodes.push(node)
    }
    const [n1, n2, n3] = nodes
    const harvest = check(await db.rpc('record_harvest_event', { p_crop_id: crop.id, p_harvest_date: addDays(today, -1), p_min_colour_percent: 85, p_ranges: [{ from: rowNumber, to: rowNumber, coverage: 'complete' }] }))[0]

    // The phone's writes, as useCollectorActions queues them.
    const now = () => new Date().toISOString()
    const answer = (node: typeof n1, status: 'BreakerFruit' | 'Harvested'): { obsId: string; writes: QueuedWrite[] } => {
      const obsId = crypto.randomUUID()
      const at = now()
      return {
        obsId,
        writes: [
          { type: 'record_status', record: { id: obsId, organization_id: org, crop_id: crop.id, plant_node_id: node.id, ...week(today), status, observed_at: at }, stemId: stem.id },
          { type: 'record_inspection_answer', record: { node_observation_id: obsId, harvest_event_id: harvest.event_id, organization_id: org, crop_id: crop.id }, plantNodeId: node.id, answerStatus: status, observedAt: at },
        ],
      }
    }
    const bytes = readFileSync(JPEG)
    const photo = (node: typeof n1, obsId: string, side: 'front' | 'back', path?: string): QueuedWrite => {
      const id = crypto.randomUUID()
      return {
        type: 'upload_photo',
        image: new Blob([bytes], { type: 'image/jpeg' }),
        preview: null,
        record: {
          id, organization_id: org, crop_id: crop.id, plant_node_id: node.id, node_observation_id: obsId, side,
          storage_path: path ?? photoPath(org, crop.id, node.id, id, 'image/jpeg'), preview_path: null, content_type: 'image/jpeg',
          bytes: bytes.length, width: 640, height: 480, sha256: createHash('sha256').update(bytes).digest('hex'), taken_at: now(), capture_meta: { test: 'photo failure' },
        },
      }
    }
    const inspected: QueuedWrite = {
      type: 'record_stem_visit',
      record: { id: crypto.randomUUID(), organization_id: org, crop_id: crop.id, measurement_stem_id: stem.id, ...week(today), checked: true, observed_at: now(), harvest_event_id: harvest.event_id, all_fruit_checked: true },
    }
    const counts = async (obsId: string) => ({
      answers: check(await db.from('harvest_inspection_answers').select('node_observation_id').eq('harvest_event_id', harvest.event_id)).length,
      photos: check(await db.from('node_photos').select('id').eq('node_observation_id', obsId)).length,
      checks: check(await db.from('stem_visits').select('id').eq('harvest_event_id', harvest.event_id)).length,
    })

    // ── 1. Storage fails temporarily (a server error): the photos and everything after them wait on the phone ──
    const cropDir = join(STORE!, 'node-photos', org, crop.id)
    mkdirSync(cropDir, { recursive: true })
    const queue = new OfflineQueue(memoryStorage(), () => crypto.randomUUID())
    const a1 = answer(n1, 'BreakerFruit') // still there, with photos
    const a2 = answer(n2, 'Harvested')
    const batch = [...a1.writes, photo(n1, a1.obsId, 'front'), photo(n1, a1.obsId, 'back'), ...a2.writes]
    for (const w of batch) await queue.enqueue(w, user)
    chmodSync(cropDir, 0o500)
    let first
    try {
      first = await queue.sync(user, executeWrite)
    } finally {
      chmodSync(cropDir, 0o700)
    }
    expect(first).toMatchObject({ synced: 2, interrupted: true, remaining: 4 })
    expect(queue.list(user).map((a) => a.type)).toEqual(['upload_photo', 'upload_photo', 'record_status', 'record_inspection_answer'])
    expect(await counts(a1.obsId)).toEqual({ answers: 1, photos: 0, checks: 0 })

    // Meanwhile the employee carries on: n3 still there, the stem completed.
    const a3 = answer(n3, 'BreakerFruit')
    for (const w of [...a3.writes, inspected]) await queue.enqueue(w, user)

    // ── 2. Storage back: everything syncs, in order ──
    expect(await queue.sync(user, executeWrite)).toMatchObject({ synced: 7, failed: 0, remaining: 0 })
    expect(await counts(a1.obsId)).toEqual({ answers: 3, photos: 2, checks: 1 })
    // The phone resends the whole inspection (e.g. a lost response): nothing is duplicated.
    for (const w of [...batch, ...a3.writes, inspected]) await queue.enqueue(w, user)
    expect(await queue.sync(user, executeWrite)).toMatchObject({ synced: 9, failed: 0, remaining: 0 })
    expect(await counts(a1.obsId)).toEqual({ answers: 3, photos: 2, checks: 1 })
    const stems = check(await db.rpc('post_harvest_inspection_stems', { p_crop_id: crop.id })).filter((s) => s.measurement_stem_id === stem.id)
    expect(stems).toMatchObject([{ state: 'complete', to_confirm: 3, answered: 3, harvested: 1 }])

    // ── 3. A photo the server refuses for good: marked failed, the rest still syncs ──
    const refusedPath = `00000000-0000-4000-8000-000000000000/${crop.id}/${n3.id}/${crypto.randomUUID()}.jpg` // another organization's folder
    await queue.enqueue(photo(n3, a3.obsId, 'front', refusedPath), user)
    const later = answer(n3, 'BreakerFruit') // a later record queued behind it
    for (const w of later.writes) await queue.enqueue(w, user)
    expect(await queue.sync(user, executeWrite)).toMatchObject({ synced: 2, failed: 1, remaining: 0 })
    // "Sync now" gives it another attempt: still refused, still kept on the phone, never lost silently.
    await queue.resetFailed(user)
    expect(await queue.sync(user, executeWrite)).toMatchObject({ synced: 0, failed: 1 })
    expect(queue.list(user)).toMatchObject([{ type: 'upload_photo', status: 'failed' }])
    // The observation is intact; the employee retakes the photos on the same record.
    expect(check(await db.from('node_observations').select('status').eq('id', a3.obsId).single())).toEqual({ status: 'BreakerFruit' })
    for (const w of [photo(n3, a3.obsId, 'front'), photo(n3, a3.obsId, 'back')]) await queue.enqueue(w, user)
    expect(await queue.sync(user, executeWrite)).toMatchObject({ synced: 2, failed: 1 })
    expect((await counts(a3.obsId)).photos).toBe(2)
  })
})
