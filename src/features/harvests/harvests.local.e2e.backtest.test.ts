// Harvests and post-harvest inspections end to end against the LOCAL stack only
// (local Postgres + PostgREST behind the preview dev server), through the same
// code the app uses: record_harvest_event(), the collector's offline queue and
// its sync (executeWrite), and the database's inspection and link functions.
// Skipped unless E2E_LOCAL_URL points at localhost. Creates its own row, so it
// can run again (harvest records are append-only).
//
//   E2E_LOCAL_URL=http://localhost:5180 E2E_ANON=… E2E_TOKEN=… npx vitest run src/features/harvests/harvests.local.e2e.backtest.test.ts

import { createClient } from '@supabase/supabase-js'
import { describe, expect, it, vi } from 'vitest'
import type { Database } from '../../lib/database.types'
import { OfflineQueue, memoryStorage, type QueuedWrite } from '../collector/offline/offlineQueue'
import { addDays, greenhouseToday } from './model'

const URL_ = process.env.E2E_LOCAL_URL
const local = Boolean(URL_ && /^http:\/\/(localhost|127\.0\.0\.1)[:/]/.test(URL_))

vi.mock('../../lib/supabase', () => ({
  supabase: createClient(process.env.E2E_LOCAL_URL ?? 'http://localhost:1', process.env.E2E_ANON ?? 'x', {
    accessToken: async () => process.env.E2E_TOKEN ?? '',
  }),
}))

/** A greenhouse (Toronto) wall time on a date, as an instant (EDT/EST resolved by Intl). */
function at(date: string, time: string): string {
  const guess = Date.parse(`${date}T${time}:00Z`)
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(new Date(guess))
      .map((p) => [p.type, p.value]),
  )
  const shown = Date.parse(`${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:00Z`)
  return new Date(guess + (guess - shown)).toISOString()
}
const isoWeek = (iso: string) => {
  const d = new Date(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)))
  const day = d.getUTCDay() || 7
  d.setUTCDate(d.getUTCDate() + 4 - day)
  const y = d.getUTCFullYear()
  return { year: y, week: Math.ceil(((d.getTime() - Date.UTC(y, 0, 1)) / 86_400_000 + 1) / 7) }
}

describe.skipIf(!local)('Harvests and post-harvest inspections against the local stack', () => {
  it('records date-only harvests within 14 days, syncs an offline inspection once, and dates the harvested fruit', { timeout: 60_000 }, async () => {
    const { supabase: db } = await import('../../lib/supabase')
    const { executeWrite } = await import('../collector/offline/networkStatus')
    const check = <R extends { data: unknown; error: { message: string; code?: string } | null }>(res: R): NonNullable<R['data']> => {
      if (res.error) throw Object.assign(new Error(res.error.message), { code: res.error.code })
      return res.data as NonNullable<R['data']>
    }
    const crop = check(await db.from('crops').select('*').eq('name', 'Cadalora').single())
    const user: string = JSON.parse(Buffer.from(process.env.E2E_TOKEN!.split('.')[1], 'base64url').toString()).sub
    const org = crop.organization_id
    const today = greenhouseToday()
    const d = (k: number) => addDays(today, k)

    // A fresh sampled row (its number unused by any variety), one stem, three fruit seen five days ago.
    const rowNumber = 800 + Math.floor(Math.random() * 190)
    const row = check(await db.from('measurement_rows').insert({ id: crypto.randomUUID(), organization_id: org, crop_id: crop.id, row_name: `Row ${rowNumber}`, sort_order: 50, is_active: true }).select().single())
    const stem = check(await db.from('measurement_stems').insert({ id: crypto.randomUUID(), organization_id: org, crop_id: crop.id, measurement_row_id: row.id, stem_name: 'Stem 1', sort_order: 1, is_active: true }).select().single())
    const node = async (n: number) =>
      check(await db.from('plant_nodes').insert({ id: crypto.randomUUID(), organization_id: org, crop_id: crop.id, measurement_stem_id: stem.id, node_number: n, sort_order: n, is_side_shoot: false, parent_node_id: null, node_label: null, side: null, is_active: true, created_at: new Date().toISOString() }).select().single())
    const [a, b, c] = [await node(1), await node(2), await node(3)]
    const seen = at(d(-5), '12:00')
    for (const [n, status] of [[a, 'BreakerFruit'], [b, 'BreakerFruit'], [c, 'MatureGreen']] as const) {
      check(await db.from('node_observations').insert({ id: crypto.randomUUID(), organization_id: org, crop_id: crop.id, plant_node_id: n.id, ...wk(d(-5)), status, observed_at: seen }))
    }
    function wk(date: string) { const w = isoWeek(date); return { year: w.year, week_number: w.week } }

    // ── Harvests: dates only, any member, inside the 14-day window ──
    const record = (date: string | null, extra: Partial<Database['public']['Functions']['record_harvest_event']['Args']> = {}) =>
      db.rpc('record_harvest_event', { p_crop_id: crop.id, p_harvest_date: date, p_min_colour_percent: 85, p_ranges: [{ from: rowNumber, to: rowNumber, coverage: 'complete' }], ...extra })
    const e1 = check(await record(d(-3)))[0]
    const e2 = check(await record(d(-1)))[0]  // the same row again within the week
    expect(e1.sampled_rows.map((r) => r.row_name)).toEqual([`Row ${rowNumber}`])
    const late = await record(d(-15))
    expect(late.error?.code).toBe('42501')
    expect(late.error?.message).toMatch(/only be entered or changed until/)
    const edge = check(await record(d(-14)))[0]
    check(await record(null, { p_note: 'test boundary', p_replaces_id: edge.version_id, p_cancel: true, p_ranges: null, p_min_colour_percent: null }))
    // A correction keeps the first version; moving it outside the window is refused.
    const corrected = check(await record(d(-3), { p_harvested_kg: 410, p_replaces_id: e1.version_id }))[0]
    expect(corrected.event_id).toBe(e1.event_id)
    expect((await record(d(-16), { p_replaces_id: corrected.version_id })).error?.code).toBe('42501')
    const versions = check(await db.from('harvest_events').select('id, recorded_by, harvested_kg').eq('event_id', e1.event_id).order('recorded_at'))
    expect(versions).toHaveLength(2)
    expect(versions.every((v) => v.recorded_by === user)).toBe(true)

    // ── E1's inspection, made offline on the phone (device time: the harvest day) ──
    const queue = new OfflineQueue(memoryStorage(), () => crypto.randomUUID())
    const answer = (n: typeof a, status: 'Harvested' | 'BreakerFruit' | 'MatureGreen', when: string, eventId: string): QueuedWrite[] => {
      const id = crypto.randomUUID()
      return [
        { type: 'record_status', record: { id, organization_id: org, crop_id: crop.id, plant_node_id: n.id, ...wk(when.slice(0, 10)), status, observed_at: when }, stemId: stem.id },
        { type: 'record_inspection_answer', record: { node_observation_id: id, harvest_event_id: eventId, organization_id: org, crop_id: crop.id }, plantNodeId: n.id, answerStatus: status, observedAt: when },
      ]
    }
    const inspected = (when: string, eventId: string): QueuedWrite => ({
      type: 'record_stem_visit',
      record: { id: crypto.randomUUID(), organization_id: org, crop_id: crop.id, measurement_stem_id: stem.id, ...wk(when.slice(0, 10)), checked: true, observed_at: when, harvest_event_id: eventId, all_fruit_checked: true },
    })
    const e1Writes = [
      ...answer(a, 'Harvested', at(d(-3), '15:00'), e1.event_id),
      ...answer(b, 'BreakerFruit', at(d(-3), '15:01'), e1.event_id),
      ...answer(c, 'MatureGreen', at(d(-3), '15:02'), e1.event_id),
      inspected(at(d(-3), '15:03'), e1.event_id),
    ]
    for (const w of e1Writes) await queue.enqueue(w, user)
    // No connection: nothing reaches the server, everything stays queued in order.
    const offline = await queue.sync(user, async () => ({ ok: false, retryable: true, message: 'Failed to fetch' }))
    expect(offline).toMatchObject({ synced: 0, remaining: 7, interrupted: true })
    expect(check(await db.from('harvest_inspection_answers').select('node_observation_id').eq('harvest_event_id', e1.event_id))).toHaveLength(0)
    // Back online: the queue syncs with the app's own executor.
    expect(await queue.sync(user, executeWrite)).toMatchObject({ synced: 7, failed: 0, remaining: 0 })
    // The phone resends everything (a lost response): nothing is duplicated.
    for (const w of e1Writes) await queue.enqueue(w, user)
    expect(await queue.sync(user, executeWrite)).toMatchObject({ synced: 7, failed: 0, remaining: 0 })
    expect(check(await db.from('harvest_inspection_answers').select('node_observation_id').eq('harvest_event_id', e1.event_id))).toHaveLength(3)
    expect(check(await db.from('stem_visits').select('id').eq('harvest_event_id', e1.event_id))).toHaveLength(1)

    // ── E2's inspection (synced straight away) ──
    for (const w of [...answer(b, 'Harvested', at(d(-1), '15:00'), e2.event_id), ...answer(c, 'MatureGreen', at(d(-1), '15:01'), e2.event_id), inspected(at(d(-1), '15:02'), e2.event_id)]) {
      await queue.enqueue(w, user)
    }
    expect(await queue.sync(user, executeWrite)).toMatchObject({ failed: 0, remaining: 0 })

    // ── What the database concludes from calendar dates ──
    const stems = check(await db.rpc('post_harvest_inspection_stems', { p_crop_id: crop.id })).filter((s) => s.measurement_stem_id === stem.id)
    expect(stems.map((s) => [s.event_id === e1.event_id ? 'E1' : 'E2', s.state, s.to_confirm, s.answered, s.harvested, s.later_harvest]).sort()).toEqual([
      ['E1', 'complete', 3, 3, 1, false],
      ['E2', 'complete', 2, 2, 1, false],
    ])
    const links = check(await db.rpc('fruit_harvest_links', { p_crop_id: crop.id })).filter((l) => l.measurement_stem_id === stem.id)
    const byNode = new Map(links.map((l) => [l.plant_node_id, l]))
    // A: last seen five days ago, harvested at E1's inspection: E1 (only harvest of the row in between).
    expect(byNode.get(a.id)).toMatchObject({ link_status: 'inferred', link_event_id: e1.event_id, harvest_date: d(-3) })
    // B: still there after E1, harvested at E2's inspection: E2.
    expect(byNode.get(b.id)).toMatchObject({ link_status: 'inferred', link_event_id: e2.event_id, harvest_date: d(-1) })
    // C is still on the plant: no link.
    expect(byNode.has(c.id)).toBe(false)
  })
})
