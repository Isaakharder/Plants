// End-to-end check of previews, server-side locking and scoring against the LOCAL stack only
// (local Postgres + PostgREST behind the preview dev server). Skipped unless
// E2E_LOCAL_URL is set, and refuses to run against anything but localhost.
//
//   E2E_LOCAL_URL=http://localhost:5180 E2E_ANON=… E2E_TOKEN=… E2E_SERVICE_TOKEN=… npx vitest run src/features/forecast/local.e2e.backtest.test.ts

import { execFileSync } from 'node:child_process'
import { createClient } from '@supabase/supabase-js'
import { describe, expect, it, vi } from 'vitest'
import type { Database } from '../../lib/database.types'

/** Test only: make a waiting job due now (as the local database owner), instead of waiting two minutes. */
async function fastForward(samplingEventId: string) {
  execFileSync('/opt/homebrew/opt/postgresql@17/bin/psql', ['-h', '127.0.0.1', '-p', '54329', '-U', 'postgres', '-d', 'plants', '-qAtc',
    `update public.forecast_lock_jobs set next_attempt_at = now() where sampling_event_id = '${samplingEventId}'`])
}

const URL_ = process.env.E2E_LOCAL_URL
const local = Boolean(URL_ && /^http:\/\/(localhost|127\.0\.0\.1)[:/]/.test(URL_))

vi.mock('../../lib/supabase', () => ({
  supabase: createClient(process.env.E2E_LOCAL_URL ?? 'http://localhost:1', process.env.E2E_ANON ?? 'x', {
    accessToken: async () => process.env.E2E_TOKEN ?? '',
  }),
}))

describe.skipIf(!local)('Harvest Forecast against the local stack', () => {
  it('previews; the server worker waits for synced checks, locks once and never overwrites', { timeout: 120_000 }, async () => {
    const { supabase } = await import('../../lib/supabase')
    const api = await import('./api')
    const { processLockJobs } = await import('./server/lockWorker')
    // The worker's own client: the service role (local key), as on the server.
    const service = createClient<Database>(URL_!, process.env.E2E_SERVICE_TOKEN!, { auth: { persistSession: false, autoRefreshToken: false } })
    const crop = (await supabase.from('crops').select('*').eq('name', 'Mathieu').single()).data!
    const now = api.currentWeek()

    // Preview from the latest sampled week (W41, 5 of 56 stems, not complete): preliminary, experimental, 8 weeks.
    const preview = await api.computePreview(crop, 2026, 41)
    expect(preview.completion).toBeNull()
    expect(preview.result.weeks).toHaveLength(8)
    expect(preview.result.confidence.level).toBe('experimental')
    expect(preview.result.dataSummary.training.verified).toBe(0)
    expect(preview.result.dataSummary.training.legacy).toBeGreaterThan(1000)
    expect(preview.result.marketingTotal.kg).toBeGreaterThan(0)
    console.log('preview W41 →', preview.result.weeks.map((w) => `+${w.horizon} ${Math.round(w.kg ?? 0)} kg`).join(', '), '| weeks 1–5:', Math.round(preview.result.marketingTotal.kg ?? 0), 'kg')

    // The phone completes this week having shown 2 stems checked, but its checks haven't synced yet.
    const stems = (await supabase.from('measurement_stems').select('id').eq('crop_id', crop.id).order('id').limit(2)).data!
    const event = (await supabase
      .from('sampling_week_events')
      .insert({ id: crypto.randomUUID(), organization_id: crop.organization_id, crop_id: crop.id, year: now.year, week_number: now.week, event: 'completed', observed_at: new Date().toISOString(), note: 'local e2e', stems_checked_seen: 2, stems_expected_seen: 56 })
      .select('id, year, week_number, observed_at, recorded_at')
      .single()).data!
    expect((await api.lockReadiness(event.id)).state).toBe('waiting_for_sync')
    expect(await processLockJobs(service)).toMatchObject({ locked: 0, failed: 0 })
    const waiting = (await supabase.from('forecast_lock_jobs').select('*').eq('sampling_event_id', event.id).single()).data!
    expect(waiting.status).toBe('waiting_for_sync')

    // The checks sync; the worker (next round, fast-forwarded here) locks the official forecast.
    await supabase.from('stem_visits').insert(
      stems.map((s) => ({ id: crypto.randomUUID(), organization_id: crop.organization_id, crop_id: crop.id, measurement_stem_id: s.id, year: now.year, week_number: now.week, checked: true, observed_at: event.observed_at })),
    )
    expect((await api.lockReadiness(event.id)).state).toBe('ready')
    await fastForward(event.id)
    const round = await processLockJobs(service)
    expect(round).toMatchObject({ locked: 1, failed: 0 })
    const job = (await supabase.from('forecast_lock_jobs').select('*').eq('sampling_event_id', event.id).single()).data!
    expect(job).toMatchObject({ status: 'done', run_kind: 'official' })
    const first = { run_id: job.run_id! }

    // Again (a retry, a second worker, a browser): the stored run is returned, nothing new.
    const completion = { id: event.id, year: event.year, week: event.week_number, observedAt: event.observed_at, recordedAt: event.recorded_at }
    const again = await api.lockForecast(crop, completion)
    expect(again).toMatchObject({ run_id: first.run_id, stored_now: false })
    expect(await processLockJobs(service)).toMatchObject({ locked: 0, alreadyLocked: 0, failed: 0 })
    expect((await supabase.from('forecast_runs').select('id').eq('crop_id', crop.id).eq('origin_week', now.week)).data).toHaveLength(1)

    const run = (await supabase.from('forecast_runs').select('*').eq('id', first.run_id).single()).data!
    expect(run.confidence).toBe('experimental')
    expect((run.data_summary as { training: { legacy: number } }).training.legacy).toBeGreaterThan(1000)
    const weeks = (await supabase.from('forecast_run_weeks').select('*').eq('run_id', first.run_id).order('horizon')).data!
    expect(weeks.map((w) => w.window)).toEqual(['marketing', 'marketing', 'marketing', 'marketing', 'marketing', 'outlook', 'outlook', 'outlook'])
    expect(Number(run.marketing_kg)).toBeCloseTo(weeks.slice(0, 5).reduce((a, w) => a + Number(w.kg), 0), 3)

    // Immutable from the client.
    const upd = await supabase.from('forecast_runs').update({ kind: 'late' } as never).eq('id', first.run_id)
    expect(upd.error).not.toBeNull()

    // Grower AFW: weeks with an AFW typed in Weekly Plant Data use it, labelled; the others use the model's estimate.
    expect(weeks.some((w) => w.afw_kind === 'grower')).toBe(true)
    expect(weeks.filter((w) => w.afw_kind === 'grower').every((w) => (w.afw_source ?? '').startsWith('Grower AFW'))).toBe(true)
  })

  it('scores a locked forecast against later records, without changing it; a past week locks as late', { timeout: 180_000 }, async () => {
    const { supabase } = await import('../../lib/supabase')
    const api = await import('./api')
    const crop = (await supabase.from('crops').select('*').eq('name', 'Mathieu').single()).data!
    // Completing W38 now is long after W39 began: late.
    const event = (await supabase
      .from('sampling_week_events')
      .insert({ id: crypto.randomUUID(), organization_id: crop.organization_id, crop_id: crop.id, year: 2026, week_number: 38, event: 'completed', observed_at: new Date().toISOString(), note: 'local e2e' })
      .select('id, year, week_number, observed_at, recorded_at')
      .single()).data!
    const late = await api.lockForecast(crop, { id: event.id, year: 2026, week: 38, observedAt: event.observed_at, recordedAt: event.recorded_at })
    expect(late).toMatchObject({ kind: 'late', stored_now: true })
    const before = (await supabase.from('forecast_run_weeks').select('*').eq('run_id', late.run_id).order('horizon')).data!

    const { accuracy, scored } = await api.loadLiveAccuracy(crop)
    expect(accuracy.lateRuns).toBeGreaterThanOrEqual(1)
    const run = scored.find((s) => s.run.id === late.run_id)!
    const status = Object.fromEntries(run.weeks.map((w) => [w.targetIndex, w.status]))
    const idx = (w: number) => run.weeks.find((x) => x.horizon === w - 38)!.targetIndex
    expect(status[idx(39)]).toBe('settled')
    expect(status[idx(41)]).toBe('unreliable') // 5 of 56 stems
    expect(run.weeks.find((w) => w.targetIndex === idx(41))!.reason).toMatch(/incomplete visit \(5 of 56 stems\)/)
    expect(['in_progress', 'pending']).toContain(status[idx(42)])
    // Late forecasts are never counted.
    expect(accuracy.horizons.every((h) => h.fruit.n === 0 || accuracy.officialRuns > 0)).toBe(true)
    console.log('W38 (late) scored:', run.weeks.map((w) => `+${w.horizon} ${w.status}${w.observedFruit !== null ? ` fc ${w.sampleFruit.toFixed(0)} obs ${w.observedFruit}` : ''}`).join(' | '))

    // Scoring changed nothing stored.
    const after = (await supabase.from('forecast_run_weeks').select('*').eq('run_id', late.run_id).order('horizon')).data!
    expect(after).toEqual(before)
  })
})
