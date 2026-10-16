// Server-side locking of official forecasts. Runs with the service-role
// database client wherever the server process lives (a Supabase Edge
// Function on a schedule, or any Node process); no browser or phone needs to
// be open.
//
// Each round claims due jobs one at a time (claim_forecast_lock_job() only
// hands out jobs whose completion is still the week's latest and whose stem
// checks have all reached the database, under a 10-minute lease), computes
// the forecast with the shared engine from the completion's observation
// cutoff, stores it with lock_forecast_run() (which decides official / late
// by the database clock and never overwrites a stored forecast) and records
// the outcome. A failure is recorded on the job, which is retried with
// back-off; nothing is half-stored, because lock_forecast_run() stores a run
// and its weeks in one transaction.

import type { Crop } from '../../crops/model'
import { createForecastData, type Db } from '../data'

export type WorkerRound = { locked: number; alreadyLocked: number; failed: number; errors: string[] }

export async function processLockJobs(db: Db, opts: { maxJobs?: number; log?: (message: string) => void } = {}): Promise<WorkerRound> {
  const data = createForecastData(db)
  const log = opts.log ?? (() => {})
  const round: WorkerRound = { locked: 0, alreadyLocked: 0, failed: 0, errors: [] }
  for (let i = 0; i < (opts.maxJobs ?? 25); i++) {
    const claimed = await db.rpc('claim_forecast_lock_job')
    if (claimed.error) throw new Error(`claim failed: ${claimed.error.message}`)
    const job = claimed.data?.[0]
    if (!job) break
    try {
      const crop = await db.from('crops').select('*').eq('id', job.crop_id).single()
      if (crop.error) throw new Error(crop.error.message)
      const event = await db.from('sampling_week_events').select('id, year, week_number, observed_at, recorded_at').eq('id', job.sampling_event_id).single()
      if (event.error) throw new Error(event.error.message)
      const result = await data.lockForecast(crop.data as Crop, {
        id: event.data.id,
        year: event.data.year,
        week: event.data.week_number,
        observedAt: event.data.observed_at,
        recordedAt: event.data.recorded_at,
      })
      if (!result) throw new Error('lock_forecast_run returned nothing')
      const finished = await db.rpc('finish_forecast_lock_job', { p_job_id: job.id, p_run_id: result.run_id })
      if (finished.error) throw new Error(finished.error.message)
      if (result.stored_now) round.locked++
      else round.alreadyLocked++
      log(`job ${job.id}: ${crop.data.name} W${job.week} ${job.year} → ${result.stored_now ? `stored (${result.kind})` : 'already locked'}`)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      round.failed++
      round.errors.push(message)
      log(`job ${job.id}: failed, will retry: ${message}`)
      await db.rpc('fail_forecast_lock_job', { p_job_id: job.id, p_error: message })
    }
  }
  return round
}
