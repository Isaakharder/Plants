// End-to-end Friday walkthrough on the LOCAL stack only (local Postgres +
// PostgREST behind the preview dev server): Breakers recorded on the phone
// (one still Breaker from last Friday, new ones, one absent), stem checks,
// "Mark sampling complete" (first incomplete, then complete), the server-side
// lock, actual harvested kg with a correction, and scoring. Skipped unless
// E2E_LOCAL_URL is set; refuses anything but localhost. Uses a fictional
// variety created for the run.
//
//   E2E_LOCAL_URL=http://localhost:5180 E2E_ANON=… E2E_TOKEN=… E2E_SERVICE_TOKEN=… npx vitest run src/features/forecast/friday.local.e2e.backtest.test.ts

import { execFileSync } from 'node:child_process'
import { createClient } from '@supabase/supabase-js'
import { describe, expect, it, vi } from 'vitest'
import type { Database } from '../../lib/database.types'

const URL_ = process.env.E2E_LOCAL_URL
const local = Boolean(URL_ && /^http:\/\/(localhost|127\.0\.0\.1)[:/]/.test(URL_))

/** Test setup as the local database owner (fixture rows for earlier weeks; never used against a remote database). */
function owner(sql: string): string {
  return execFileSync('/opt/homebrew/opt/postgresql@17/bin/psql', ['-h', '127.0.0.1', '-p', '54329', '-U', 'postgres', '-d', 'plants', '-v', 'ON_ERROR_STOP=1', '-qAtc', sql]).toString().trim()
}

vi.mock('../../lib/supabase', () => ({
  supabase: createClient(process.env.E2E_LOCAL_URL ?? 'http://localhost:1', process.env.E2E_ANON ?? 'x', {
    accessToken: async () => process.env.E2E_TOKEN ?? '',
  }),
}))

describe.skipIf(!local)('Friday walkthrough → forecast → actual kg → accuracy (local stack)', () => {
  it('locks next week from this Friday’s Breakers once every stem is checked, and scores against entered actual kg', { timeout: 180_000 }, async () => {
    const { supabase } = await import('../../lib/supabase')
    const api = await import('./api')
    const { processLockJobs } = await import('./server/lockWorker')
    const { weekOfIndex, weekStartInstant } = await import('./engine/weeks')
    const service = createClient<Database>(URL_!, process.env.E2E_SERVICE_TOKEN!, { auth: { persistSession: false, autoRefreshToken: false } })

    const now = api.currentWeek()
    const wk = (offset: number) => weekOfIndex(now.index + offset)
    const fridayOf = (offset: number) => new Date(weekStartInstant(now.index + offset).getTime() + 4 * 86_400_000 + 12 * 3_600_000).toISOString()
    const org = owner('select id from public.organizations limit 1')
    const name = `E2E Friday ${Date.now()}`
    // A fictional variety: 4 sampled stems, 1,200 picking stems, case 5 kg; Breakers only from two weeks ago; AFW 180 g.
    const ids = owner(`
      with c as (insert into public.crops (organization_id, name, color, planting_date, pullout_date, area_m2, picking_stems, case_weight_kg)
                 values ('${org}', '${name}', 'orange', '2026-01-01', '2027-06-30', 100, 1200, 5) returning id),
           r as (insert into public.measurement_rows (organization_id, crop_id, row_name) select '${org}', id, 'E2E Row' from c returning id, crop_id),
           s as (insert into public.measurement_stems (organization_id, crop_id, measurement_row_id, stem_name, sort_order)
                 select '${org}', r.crop_id, r.id, 'Stem ' || g, g from r, generate_series(1, 4) g returning id, sort_order)
      select string_agg(id::text, ',' order by sort_order) from s`)
    const stems = ids.split(',')
    const crop = (await supabase.from('crops').select('*').eq('name', name).single()).data!
    const node = (stem: number, n: number) =>
      owner(`insert into public.plant_nodes (organization_id, crop_id, measurement_stem_id, node_number, sort_order, created_at)
             values ('${org}', '${crop.id}', '${stems[stem - 1]}', ${n}, ${n}, '${fridayOf(-3)}') returning id`)
    const n1 = node(1, 1) // Breaker two weeks ago, last Friday and still this Friday
    const n2 = node(2, 1) // Breaker last Friday, absent this Friday (stem checked)
    const n3 = node(1, 2) // new this Friday
    const n4 = node(4, 1) // Breaker two weeks ago only
    const n5 = node(4, 2) // new this Friday
    const obs = (nodeId: string, offset: number) =>
      `('${org}', '${crop.id}', '${nodeId}', ${wk(offset).year}, ${wk(offset).week}, 'BreakerFruit', '${fridayOf(offset)}', '${fridayOf(offset)}')`
    const checks = (offset: number) =>
      stems.map((s) => `('${org}', '${crop.id}', '${s}', ${wk(offset).year}, ${wk(offset).week}, true, '${fridayOf(offset)}', '${fridayOf(offset)}')`).join(',')
    // Two earlier walkthroughs, complete (every stem checked), as recorded at the time.
    owner(`
      insert into public.node_observations (organization_id, crop_id, plant_node_id, year, week_number, status, observed_at, recorded_at)
      values ${obs(n1, -2)}, ${obs(n4, -2)}, ${obs(n1, -1)}, ${obs(n2, -1)};
      insert into public.stem_visits (organization_id, crop_id, measurement_stem_id, year, week_number, checked, observed_at, recorded_at) values ${checks(-2)}, ${checks(-1)};
      insert into public.forecast_basis_settings (organization_id, crop_id, from_year, from_week, basis, harvest_ready_share, note)
      values ('${org}', '${crop.id}', ${wk(-2).year}, ${wk(-2).week}, 'breaker_only', 0.85, 'e2e');
      insert into public.weekly_harvest_afw (organization_id, crop_id, year, week, afw_g)
      select '${org}', '${crop.id}', y, w, 180 from (values (${wk(-1).year}, ${wk(-1).week}), (${now.year}, ${now.week}), (${wk(1).year}, ${wk(1).week})) v(y, w);`)

    // ── This Friday, on the phone (as the member) ──────────────────────────────
    const record = (nodeId: string) =>
      supabase.from('node_observations').insert({ id: crypto.randomUUID(), organization_id: org, crop_id: crop.id, plant_node_id: nodeId, year: now.year, week_number: now.week, status: 'BreakerFruit', observed_at: new Date().toISOString() })
    expect((await record(n1)).error).toBeNull() // "Still Breaker"
    expect((await record(n1)).error).toBeNull() // tapped twice: still one pepper
    expect((await record(n3)).error).toBeNull()
    const check = (stem: string, at = new Date().toISOString()) =>
      supabase.from('stem_visits').insert({ id: crypto.randomUUID(), organization_id: org, crop_id: crop.id, measurement_stem_id: stem, year: now.year, week_number: now.week, checked: true, observed_at: at })
    for (const s of stems.slice(0, 3)) expect((await check(s)).error).toBeNull()

    // Marked complete with 3 of 4 stems checked: previewed (labelled incomplete), never locked.
    const complete = async (seen: number) =>
      (await supabase
        .from('sampling_week_events')
        .insert({ id: crypto.randomUUID(), organization_id: org, crop_id: crop.id, year: now.year, week_number: now.week, event: 'completed', observed_at: new Date().toISOString(), stems_checked_seen: seen, stems_expected_seen: 4 })
        .select('id, year, week_number, observed_at, recorded_at')
        .single()).data!
    const first = await complete(3)
    expect((await api.lockReadiness(first.id)).state).toBe('incomplete')
    const partial = await api.computePreview(crop, now.year, now.week)
    expect(partial.result.basis).toBe('breaker_only')
    // Stem 4 not checked: left out (n5 not counted), 3 stems.
    expect(partial.result.coverage).toMatchObject({ visited: 3, expected: 4 })
    expect(partial.result.confidence.reasons.some((r) => r.startsWith('Incomplete walkthrough: 3 of 4'))).toBe(true)
    expect(await processLockJobs(service)).toMatchObject({ locked: 0, failed: 0 })
    expect((await supabase.from('forecast_lock_jobs').select('status').eq('sampling_event_id', first.id).single()).data!.status).toBe('incomplete')

    // The last stem walked (a new Breaker) and checked, sampling reopened and completed again: locked automatically.
    await new Promise((r) => setTimeout(r, 20))
    expect((await record(n5)).error).toBeNull()
    expect((await check(stems[3])).error).toBeNull()
    await supabase.from('sampling_week_events').insert({ id: crypto.randomUUID(), organization_id: org, crop_id: crop.id, year: now.year, week_number: now.week, event: 'reopened', observed_at: new Date().toISOString() })
    await new Promise((r) => setTimeout(r, 20))
    const second = await complete(4)
    expect((await api.lockReadiness(second.id)).state).toBe('ready')
    expect(await processLockJobs(service)).toMatchObject({ locked: 1, failed: 0 })
    const job = (await supabase.from('forecast_lock_jobs').select('*').eq('sampling_event_id', second.id).single()).data!
    expect(job).toMatchObject({ status: 'done', run_kind: 'official' })

    const run = (await supabase.from('forecast_runs').select('*').eq('id', job.run_id!).single()).data!
    expect(run).toMatchObject({ basis: 'breaker_only', confidence: 'experimental', sample_stems: 4, marketing_kg: null })
    expect(Number(run.harvest_ready_share)).toBe(0.85)
    expect(Number(run.coverage)).toBe(1)
    // n1 still Breaker (counted once), n3 and n5 new, n2 not recorded again (out of the inventory, not harvested).
    expect(run.breaker_breakdown).toMatchObject({ total: 3, carriedOver: 1, new: 2, firstSeen: 0, notRecordedAgain: 1 })
    const weeks = (await supabase.from('forecast_run_weeks').select('*').eq('run_id', run.id).order('horizon')).data!
    expect(weeks.map((w) => w.available)).toEqual([true, false, false, false, false, false, false, false])
    expect(Number(weeks[0].crop_fruit)).toBeCloseTo(0.85 * 3 * (1200 / 4), 6) // 765 peppers
    expect(Number(weeks[0].kg)).toBeCloseTo((765 * 180) / 1000, 6) // 137.7 kg
    expect(Number(weeks[0].cases)).toBeCloseTo(137.7 / 5, 6)
    expect(weeks.slice(1).every((w) => w.kg === null && w.crop_fruit === null)).toBe(true)

    // ── Last Friday's forecast (locked now, so late), scored against actual kg ──
    const lastEvent = owner(`insert into public.sampling_week_events (organization_id, crop_id, year, week_number, event, observed_at, recorded_at, stems_checked_seen, stems_expected_seen)
                             values ('${org}', '${crop.id}', ${wk(-1).year}, ${wk(-1).week}, 'completed', '${fridayOf(-1)}', '${fridayOf(-1)}', 4, 4) returning id`)
    await processLockJobs(service)
    const lastRun = (await supabase.from('forecast_runs').select('*').eq('crop_id', crop.id).eq('origin_week', wk(-1).week).single()).data!
    expect(lastRun.kind).toBe('late')
    expect(lastRun.sampling_event_id).toBe(lastEvent)
    // Last Friday: n1 (still Breaker) and n2 (new): 0.85 × 2 × 300 × 180 g = 91.8 kg forecast for this week… which is in progress.
    // The week before: enter its actual kg, then a correction; the newest entry counts.
    const actual = (week: { year: number; week: number }, kg: number | null, note: string | null) =>
      supabase.from('weekly_harvest_actuals').insert({ organization_id: org, crop_id: crop.id, year: week.year, week: week.week, actual_kg: kg, note })
    expect((await actual(wk(-1), 100, null)).error).toBeNull()
    await new Promise((r) => setTimeout(r, 20))
    expect((await actual(wk(-1), 90, 'corrected from the packhouse total')).error).toBeNull()
    const twoAgoEvent = owner(`insert into public.sampling_week_events (organization_id, crop_id, year, week_number, event, observed_at, recorded_at, stems_checked_seen, stems_expected_seen)
                               values ('${org}', '${crop.id}', ${wk(-2).year}, ${wk(-2).week}, 'completed', '${fridayOf(-2)}', '${fridayOf(-2)}', 4, 4) returning id`)
    await processLockJobs(service)
    const twoAgo = (await supabase.from('forecast_runs').select('*').eq('sampling_event_id', twoAgoEvent).single()).data!
    const twoAgoWeek1 = (await supabase.from('forecast_run_weeks').select('*').eq('run_id', twoAgo.id).eq('horizon', 1).single()).data!
    // Two weeks ago: n1 and n4 first seen (the variety's first walkthrough): 0.85 × 2 × 300 × 180 g = 91.8 kg for last week.
    expect(Number(twoAgoWeek1.kg)).toBeCloseTo(91.8, 6)

    const live = await api.loadLiveAccuracy(crop)
    const scored = live.actual.runs.find((r) => r.run.id === twoAgo.id)!
    expect(scored.weeks[0]).toMatchObject({ status: 'scored', actualKg: 90 })
    expect(scored.weeks[0].error!).toBeCloseTo(91.8 / 90 - 1, 6)
    expect(scored.weeks[0].impliedShare!).toBeCloseTo((0.85 * 90) / 91.8, 6)
    expect(live.actual.runs.find((r) => r.run.id === lastRun.id)!.weeks[0].status).toBe('in_progress')
    expect(live.actual.runs.find((r) => r.run.id === run.id)!.weeks[0].status).toBe('pending')
    // Late forecasts are shown and scored, never counted toward validation.
    expect(live.actual.horizons.find((h) => h.basis === 'breaker_only')!.kg.n).toBe(0)
    console.log(`Friday e2e (${name}): this Friday ${run.breaker_breakdown ? JSON.stringify(run.breaker_breakdown) : ''} → next week ${Number(weeks[0].kg).toFixed(1)} kg; two weeks ago forecast 91.8 kg vs actual 90 kg (${(100 * scored.weeks[0].error!).toFixed(1)}%)`)
  })
})
