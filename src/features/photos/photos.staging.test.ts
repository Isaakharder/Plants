// Breaker photos against the STAGING Supabase project (real Storage and
// sign-in). Skipped unless VITE_STAGING_URL, VITE_STAGING_KEY and the test
// accounts are given; refuses to run against the production project.
//
//   VITE_STAGING_URL=https://<staging-ref>.supabase.co VITE_STAGING_KEY=<publishable key>
//   VITE_STAGING_TESTER=email:password VITE_STAGING_OUTSIDER=email:password
//   npx vitest run src/features/photos/photos.staging.test.ts

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { describe, expect, it, vi } from 'vitest'
import type { Database } from '../../lib/database.types'

const env = import.meta.env as Record<string, string | undefined>
const URL_ = env.VITE_STAGING_URL
const PRODUCTION_REF = 'qaopjmaiqezvrskpnrsx'
const enabled = Boolean(URL_ && env.VITE_STAGING_KEY && env.VITE_STAGING_TESTER && env.VITE_STAGING_OUTSIDER && !URL_.includes(PRODUCTION_REF))

type Db = SupabaseClient<Database>
const signedIn = async (account: string): Promise<Db> => {
  const [email, password] = account.split(':')
  const db = createClient<Database>(URL_!, env.VITE_STAGING_KEY!, { auth: { persistSession: false, autoRefreshToken: false } })
  const { error } = await db.auth.signInWithPassword({ email, password })
  if (error) throw error
  return db
}

// The viewer's api.ts uses the app's client: give it the tester's session.
const holder = vi.hoisted(() => ({ db: null as unknown }))
vi.mock('../../lib/supabase', () => ({
  get supabase() {
    return holder.db
  },
}))

describe.skipIf(!enabled)('Breaker photos on staging', () => {
  it('stores privately, never duplicates, blocks other organizations, and corrections only add rows', { timeout: 120_000 }, async () => {
    const tester = await signedIn(env.VITE_STAGING_TESTER!)
    const outsider = await signedIn(env.VITE_STAGING_OUTSIDER!)
    holder.db = tester
    const { PHOTO_BUCKET, sendPhoto } = await import('../collector/offline/photoUpload')
    const { photoPath, previewPath, sha256Hex } = await import('../collector/photos')
    const { addColourEstimate, addPairCorrection } = await import('./api')
    const { buildPairs } = await import('./model')
    const uploader = (db: Db) => ({
      upload: (path: string, body: ArrayBuffer, contentType: string) => db.storage.from(PHOTO_BUCKET).upload(path, body, { contentType, upsert: false }),
      insertRecord: async (record: Record<string, unknown>) => {
        const res = await db.from('node_photos').upsert(record as never, { onConflict: 'id', ignoreDuplicates: true })
        return { error: res.error, status: res.status }
      },
    })

    const crop = (await tester.from('crops').select('*').eq('name', 'Test Red').single()).data!
    const [node, other] = (await tester.from('plant_nodes').select('*').eq('crop_id', crop.id).eq('node_number', 1).order('id').limit(2)).data!
    const obsId = crypto.randomUUID()
    const { year, week } = (() => {
      const d = new Date()
      const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
      t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7))
      return { year: t.getUTCFullYear(), week: Math.ceil(((t.getTime() - Date.UTC(t.getUTCFullYear(), 0, 1)) / 86400000 + 1) / 7) }
    })()
    expect((await tester.from('node_observations').insert({ id: obsId, organization_id: crop.organization_id, crop_id: crop.id, plant_node_id: node.id, year, week_number: week, status: 'BreakerFruit', observed_at: new Date().toISOString() })).error).toBeNull()

    for (const side of ['front', 'back'] as const) {
      const bytes = new TextEncoder().encode(`staging ${side} ${obsId}`)
      const id = crypto.randomUUID()
      const preview = new Blob([new TextEncoder().encode(`preview ${side} ${obsId}`)], { type: 'image/jpeg' })
      const record = {
        id, organization_id: crop.organization_id, crop_id: crop.id, plant_node_id: node.id, node_observation_id: obsId, side,
        storage_path: photoPath(crop.organization_id, crop.id, node.id, id, 'image/jpeg'), preview_path: previewPath(crop.organization_id, crop.id, node.id, id),
        content_type: 'image/jpeg', bytes: bytes.length, sha256: await sha256Hex(bytes.buffer as ArrayBuffer), taken_at: new Date().toISOString(),
        capture_meta: { source: 'staging-test' },
      }
      const image = new Blob([bytes], { type: 'image/jpeg' })
      expect(await sendPhoto(uploader(tester), record, image, preview)).toEqual({ ok: true })
      expect(await sendPhoto(uploader(tester), record, image, preview)).toEqual({ ok: true }) // a retry: no duplicate
      const folder = await tester.storage.from(PHOTO_BUCKET).list(`${crop.organization_id}/${crop.id}/${node.id}`, { search: id })
      expect(folder.data!.map((o) => o.name).sort()).toEqual([`${id}.jpg`, `${id}.preview.jpg`])

      // The owner reads it with a session or a short-lived signed URL…
      expect(await (await tester.storage.from(PHOTO_BUCKET).download(record.storage_path)).data!.text()).toBe(`staging ${side} ${obsId}`)
      const signed = await tester.storage.from(PHOTO_BUCKET).createSignedUrl(record.storage_path, 60)
      expect((await fetch(signed.data!.signedUrl)).status).toBe(200)
      // … never through a public URL, never as another organization.
      expect((await fetch(`${URL_}/storage/v1/object/public/${PHOTO_BUCKET}/${record.storage_path}`)).ok).toBe(false)
      expect((await outsider.storage.from(PHOTO_BUCKET).download(record.storage_path)).error).not.toBeNull()
      expect((await outsider.storage.from(PHOTO_BUCKET).upload(`${crop.organization_id}/x/y/${crypto.randomUUID()}.jpg`, new Uint8Array([1]).buffer, { contentType: 'image/jpeg' })).error).not.toBeNull()
    }
    expect((await outsider.from('node_photos').select('id').eq('node_observation_id', obsId)).data).toEqual([])

    const load = async () => {
      const photos = (await tester.from('node_photos').select('*').eq('node_observation_id', obsId)).data!
      return buildPairs({
        photos,
        analyses: (await tester.from('photo_colour_analyses').select('*').eq('node_observation_id', obsId)).data!,
        corrections: (await tester.from('photo_pair_corrections').select('*').eq('node_observation_id', obsId)).data!,
        stems: new Map(), rows: new Map(),
        nodes: new Map([[other.id, { id: other.id, stemId: other.measurement_stem_id, nodeNumber: other.node_number, label: null, isSideShoot: false }]]),
      })[0]
    }
    let pair = await load()
    expect(pair.front?.target_colour).toBe('red')
    await addColourEstimate(pair, { front: 40, back: 20, combined: 30, note: 'staging test' })
    pair = await load()
    await addColourEstimate(pair, { front: 40, back: 30, combined: 35, note: 'staging correction' })
    pair = await load()
    expect(pair.colourHistory).toHaveLength(2)
    expect(Number(pair.colour!.combined_percent)).toBe(35)
    await addPairCorrection(pair, 'reassign_node', other.id, 'staging test')
    expect((await load()).assignment.kind).toBe('reassign_node')
    expect((await tester.from('node_photos').select('plant_node_id').eq('node_observation_id', obsId)).data!.every((p) => p.plant_node_id === node.id)).toBe(true)
    // Clients can't change or delete stored rows or objects.
    expect((await tester.from('node_photos').update({ side: 'back' } as never).eq('node_observation_id', obsId)).error).not.toBeNull()
    const removed = await tester.storage.from(PHOTO_BUCKET).remove([pair.front!.storage_path])
    expect(removed.data ?? []).toEqual([])
    expect((await tester.storage.from(PHOTO_BUCKET).download(pair.front!.storage_path)).error).toBeNull()
  })
})
