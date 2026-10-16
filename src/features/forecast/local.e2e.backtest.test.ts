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
  it('previews the lifecycle forecast; the server worker waits for synced checks and never locks an incomplete walkthrough', { timeout: 120_000 }, async () => {
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

    // The checks sync, but only 2 of the 56 sampled stems were checked: no official forecast (20261024: every sampled stem must be checked).
    await supabase.from('stem_visits').insert(
      stems.map((s) => ({ id: crypto.randomUUID(), organization_id: crop.organization_id, crop_id: crop.id, measurement_stem_id: s.id, year: now.year, week_number: now.week, checked: true, observed_at: event.observed_at })),
    )
    const readiness = await api.lockReadiness(event.id)
    expect(readiness.state).toBe('incomplete')
    expect(readiness.detail).toMatch(/2 of the \d+ sampled stems were checked/)
    await fastForward(event.id)
    expect(await processLockJobs(service)).toMatchObject({ locked: 0, failed: 0 })
    expect((await supabase.from('forecast_lock_jobs').select('status').eq('sampling_event_id', event.id).single()).data!.status).toBe('incomplete')
    expect((await supabase.from('forecast_runs').select('id').eq('crop_id', crop.id).eq('origin_week', now.week)).data).toHaveLength(0)
  })

  it('scores a locked forecast against later records, without changing it; a past week locks as late', { timeout: 180_000 }, async () => {
    const { supabase } = await import('../../lib/supabase')
    const api = await import('./api')
    const crop = (await supabase.from('crops').select('*').eq('name', 'Mathieu').single()).data!
    // Every stem visited in W38 checked (as on that Friday), then completing W38 now, long after W39 began: late.
    const visited = execFileSync('/opt/homebrew/opt/postgresql@17/bin/psql', ['-h', '127.0.0.1', '-p', '54329', '-U', 'postgres', '-d', 'plants', '-qAtc',
      `select string_agg(distinct n.measurement_stem_id::text, ',') from public.node_observations o join public.plant_nodes n on n.id = o.plant_node_id where o.crop_id = '${crop.id}' and o.year = 2026 and o.week_number = 38`]).toString().trim().split(',')
    await supabase.from('stem_visits').insert(
      visited.map((stem) => ({ id: crypto.randomUUID(), organization_id: crop.organization_id, crop_id: crop.id, measurement_stem_id: stem, year: 2026, week_number: 38, checked: true, observed_at: '2026-09-18T16:00:00Z' })),
    )
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
