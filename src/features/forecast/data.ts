// Harvest Forecast data access shared by the app and the server-side lock
// worker: loads a crop's records for the engine as they stood at a cutoff,
// computes previews, locks forecasts through lock_forecast_run(), and scores
// locked forecasts. Everything goes through the database client it is given:
// the signed-in user's (RLS applies) or the worker's service-role client.

import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database, NodeStatus } from '../../lib/database.types'
import { fetchAll } from '../collector/fetchAll'
import type { Crop } from '../crops/model'
import { forecastForWeek } from './engine/forecast'
import { latestRevisions } from './revisions'
import { buildHistory } from './engine/history'
import { actualsInEffect, liveAccuracy, type ActualAccuracy, type LiveAccuracy, type LiveRun, type ScoredRun, type SamplingWeek } from './engine/live'
import type { EngineAfw, EngineBasisSetting, EngineFlag, EngineInput, ForecastBasis, ForecastResult } from './engine/types'
import { FORECAST_WEEKS, MARKETING_WEEKS } from './engine/types'
import { greenhouseWeekIndex, weekIndex, weekOfIndex } from './engine/weeks'

export type Db = SupabaseClient<Database>

export type SamplingCompletion = { id: string; year: number; week: number; observedAt: string; recordedAt: string }
export type Preview = { result: ForecastResult; afwHistory: 'log' | 'current'; origin: { year: number; week: number }; completion: SamplingCompletion | null; computedAt: string }
/** A preliminary forecast as saved (forecast_previews), with the data signature it was computed from. */
export type SavedPreview = { id: string; preview: Preview; inputSignature: string; engineVersion: string; createdAt: string }
/** Weeks ahead validated so far, per basis (lifecycle: against Harvested records; Breakers only: against actual kg). */
export type ValidatedByBasis = Record<ForecastBasis, number[]>
export type LiveAccuracyResult = { accuracy: LiveAccuracy; scored: ScoredRun[]; actual: ActualAccuracy; validatedByBasis: ValidatedByBasis }
/** A variety without a basis setting gets the next-week forecast from Breakers (no rates are assumed). */
export const DEFAULT_BASIS: ForecastBasis = 'breaker_only'

const num = (v: number | null) => (v === null ? null : Number(v))

export function createForecastData(supabase: Db) {
  const check = <T>(res: { data: T | null; error: { message: string } | null }): T => {
    if (res.error) throw new Error(res.error.message)
    return res.data as T
  }
  const count = (withCount: boolean) => (withCount ? { count: 'exact' as const } : undefined)

  /** AFW per week as entered by `cutoff` (from the change log); the current values when the log has nothing that old. */
  async function loadAfw(cropId: string, cutoff: string): Promise<{ afw: EngineAfw[]; history: 'log' | 'current' }> {
    const log = await fetchAll((after, limit, withCount) => {
      let q = supabase.from('weekly_harvest_afw_log').select('id, year, week, afw_g, logged_at', count(withCount)).eq('crop_id', cropId).lte('logged_at', cutoff)
      if (after) q = q.gt('id', Number(after))
      return q.order('id').limit(limit)
    }, (r) => String(r.id).padStart(15, '0'))
    if (log.length > 0) {
      const latest = new Map<string, { afw_g: number | null; logged_at: string; id: number }>()
      for (const r of log) {
        const key = `${r.year}:${r.week}`
        const cur = latest.get(key)
        if (!cur || r.logged_at > cur.logged_at || (r.logged_at === cur.logged_at && r.id > cur.id)) latest.set(key, r)
      }
      const afw = [...latest.entries()]
        .filter(([, r]) => r.afw_g !== null)
        .map(([key, r]) => ({ year: Number(key.split(':')[0]), week: Number(key.split(':')[1]), afwG: Number(r.afw_g) }))
      return { afw, history: 'log' }
    }
    const current = check(await supabase.from('weekly_harvest_afw').select('year, week, afw_g').eq('crop_id', cropId))
    return { afw: current.map((r) => ({ year: r.year, week: r.week, afwG: Number(r.afw_g) })), history: 'current' }
  }

  /** Every forecast basis setting of the crop (the engine applies its cutoff). */
  async function loadBasisSettings(cropId: string): Promise<EngineBasisSetting[]> {
    const rows = check(
      await supabase.from('forecast_basis_settings').select('from_year, from_week, basis, harvest_ready_share, created_at').eq('crop_id', cropId).order('created_at'),
    )
    return rows.map((r) => ({
      fromYear: r.from_year,
      fromWeek: r.from_week,
      basis: r.basis,
      harvestReadyShare: r.harvest_ready_share === null ? null : Number(r.harvest_ready_share),
      createdAt: r.created_at,
    }))
  }

  /** Actual harvested kg in effect per week index (the newest entry; cleared weeks left out). */
  async function loadActualKg(cropId: string): Promise<Map<number, number>> {
    const rows = check(await supabase.from('weekly_harvest_actuals').select('id, year, week, actual_kg, entered_at').eq('crop_id', cropId))
    return actualsInEffect(rows.map((r) => ({ id: r.id, year: r.year, week: r.week, actualKg: r.actual_kg === null ? null : Number(r.actual_kg), enteredAt: r.entered_at })))
  }

  /** Everything the engine needs for one crop, with flags and AFW as they stood at `cutoff`. */
  async function loadEngineInput(crop: Pick<Crop, 'id' | 'picking_stems' | 'area_m2'>, cutoff: string): Promise<EngineInput & { afwHistory: 'log' | 'current' }> {
    // The same paginated read for each table; the callers state each row's shape.
    type Page<T> = PromiseLike<{ data: T[] | null; error: { message: string } | null; status: number; count?: number | null }>
    type Table = 'measurement_stems' | 'plant_nodes' | 'node_observations' | 'stem_growth_measurements' | 'stem_visits' | 'sampling_week_events'
    const byCrop = <T extends { id: string }>(table: Table, columns: string) =>
      fetchAll<T>((after, limit, withCount) => {
        let q = supabase.from(table).select(columns, count(withCount)).eq('crop_id', crop.id)
        if (after) q = q.gt('id', after)
        return q.order('id').limit(limit) as unknown as Page<T>
      }, (r) => r.id)

    const [stems, nodes, observations, growth, visits, events, flags, afw, basisSettings] = await Promise.all([
      byCrop<{ id: string; measurement_row_id: string; is_active: boolean }>('measurement_stems', 'id, measurement_row_id, is_active'),
      byCrop<{ id: string; measurement_stem_id: string; is_side_shoot: boolean; is_active: boolean; created_at: string }>('plant_nodes', 'id, measurement_stem_id, is_side_shoot, is_active, created_at'),
      byCrop<{ id: string; plant_node_id: string; year: number; week_number: number; status: NodeStatus; observed_at: string; recorded_at: string }>(
        'node_observations',
        'id, plant_node_id, year, week_number, status, observed_at, recorded_at',
      ),
      byCrop<{ id: string; measurement_stem_id: string; year: number; week_number: number; observed_at: string }>('stem_growth_measurements', 'id, measurement_stem_id, year, week_number, observed_at'),
      byCrop<{ id: string; measurement_stem_id: string; year: number; week_number: number; checked: boolean; observed_at: string; recorded_at: string }>(
        'stem_visits',
        'id, measurement_stem_id, year, week_number, checked, observed_at, recorded_at',
      ),
      byCrop<{ id: string; year: number; week_number: number; event: 'completed' | 'reopened'; observed_at: string; recorded_at: string }>(
        'sampling_week_events',
        'id, year, week_number, event, observed_at, recorded_at',
      ),
      supabase.rpc('crop_quality_flags', { p_crop_id: crop.id, p_as_of: cutoff }).then(check),
      loadAfw(crop.id, cutoff),
      loadBasisSettings(crop.id),
    ])

    return {
      crop: { id: crop.id, pickingStems: Number(crop.picking_stems), areaM2: Number(crop.area_m2) },
      stems: stems.map((s) => ({ id: s.id, rowId: s.measurement_row_id, isActive: s.is_active })),
      nodes: nodes.map((n) => ({ id: n.id, stemId: n.measurement_stem_id, isSideShoot: n.is_side_shoot, isActive: n.is_active, createdAt: n.created_at })),
      observations: observations.map((o) => ({ id: o.id, nodeId: o.plant_node_id, year: o.year, week: o.week_number, status: o.status, observedAt: o.observed_at, recordedAt: o.recorded_at })),
      growth: growth.map((g) => ({ stemId: g.measurement_stem_id, year: g.year, week: g.week_number, observedAt: g.observed_at })),
      stemVisits: visits.map((v) => ({ stemId: v.measurement_stem_id, year: v.year, week: v.week_number, checked: v.checked, observedAt: v.observed_at, recordedAt: v.recorded_at })),
      samplingEvents: events.map((e) => ({ year: e.year, week: e.week_number, event: e.event, observedAt: e.observed_at, recordedAt: e.recorded_at })),
      afw: afw.afw,
      afwHistory: afw.history,
      basisSettings,
      flags: flags.map(
        (f): EngineFlag => ({
          flagKey: f.flag_key,
          ruleId: f.rule_id,
          scope: f.scope,
          yw: f.yw,
          stemId: f.measurement_stem_id,
          nodeId: f.plant_node_id,
          reviewDecision: f.review_decision,
        }),
      ),
    }
  }


  /** The crop's latest sampling event for a week, when it says completed. */
  async function latestCompletion(cropId: string, year: number, week: number): Promise<SamplingCompletion | null> {
    const rows = check(
      await supabase
        .from('sampling_week_events')
        .select('id, year, week_number, event, observed_at, recorded_at')
        .eq('crop_id', cropId)
        .eq('year', year)
        .eq('week_number', week)
        .order('recorded_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(1),
    )
    const e = rows[0]
    return e && e.event === 'completed' ? { id: e.id, year: e.year, week: e.week_number, observedAt: e.observed_at, recordedAt: e.recorded_at } : null
  }


  /**
   * A forecast computed now from a sampling week, not stored. Preliminary when
   * that week's sampling isn't marked complete; it never replaces a locked
   * forecast.
   */
  async function computePreview(crop: Crop, originYear: number, originWeek: number, validatedByBasis?: ValidatedByBasis): Promise<Preview> {
    const now = new Date().toISOString()
    const [input, completion] = await Promise.all([loadEngineInput(crop, now), latestCompletion(crop.id, originYear, originWeek)])
    const result = forecastForWeek(input, {
      originIndex: weekIndex(originYear, originWeek),
      cutoff: now,
      // A completed week is forecast from what was observed by its completion, like the official one.
      observedCutoff: completion?.observedAt,
      horizon: FORECAST_WEEKS,
      defaultBasis: DEFAULT_BASIS,
      validatedByBasis,
    })
    return { result, afwHistory: input.afwHistory, origin: { year: originYear, week: originWeek }, completion, computedAt: now }
  }

  /** The signature of the data a forecast from (year, week) reads (forecast_input_signature): it changes whenever that data does. */
  async function inputSignature(cropId: string, year: number, week: number): Promise<string> {
    return check(await supabase.rpc('forecast_input_signature', { p_crop_id: cropId, p_year: year, p_week: week }))
  }

  /**
   * Generate forecast: computes a preliminary forecast and saves it for the
   * variety and sampling week (a new row; earlier ones stay). The signature
   * is read before computing, so data arriving meanwhile marks it outdated.
   */
  async function generatePreview(crop: Crop, originYear: number, originWeek: number, validatedByBasis?: ValidatedByBasis): Promise<SavedPreview> {
    const signature = await inputSignature(crop.id, originYear, originWeek)
    const preview = await computePreview(crop, originYear, originWeek, validatedByBasis)
    const row = check(
      await supabase
        .from('forecast_previews')
        .insert({
          organization_id: crop.organization_id,
          crop_id: crop.id,
          origin_year: originYear,
          origin_week: originWeek,
          basis: preview.result.basis,
          engine_version: preview.result.engineVersion,
          input_signature: signature,
          preview: preview as unknown as Database['public']['Tables']['forecast_previews']['Insert']['preview'],
        })
        .select('id, created_at')
        .single(),
    ) as { id: string; created_at: string } | null
    if (!row) throw new Error('The preliminary forecast wasn’t saved')
    return { id: row.id, preview, inputSignature: signature, engineVersion: preview.result.engineVersion, createdAt: row.created_at }
  }

  /** The newest saved preliminary forecast of a variety and sampling week (null when none). */
  async function latestPreview(cropId: string, year: number, week: number): Promise<SavedPreview | null> {
    const rows = check(
      await supabase
        .from('forecast_previews')
        .select('id, preview, input_signature, engine_version, created_at')
        .eq('crop_id', cropId)
        .eq('origin_year', year)
        .eq('origin_week', week)
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(1),
    )
    const r = rows[0]
    return r ? { id: r.id, preview: r.preview as Preview, inputSignature: r.input_signature, engineVersion: r.engine_version, createdAt: r.created_at } : null
  }

  /**
   * Computes and locks the forecast of a completed sampling week. Returns the
   * stored run (an existing one when the week was already locked, by this or
   * another device: it is never overwritten).
   */
  async function lockForecast(crop: Crop, completion: SamplingCompletion, validatedByBasis?: ValidatedByBasis) {
    // The weeks ahead validated by live accuracy so far, for the forecast's confidence statement.
    const validated = validatedByBasis ?? (await loadLiveAccuracy(crop)).validatedByBasis
    // Stored-by cutoff: now, a little early so the server's clock can't be behind it, but never before the
    // completion reached the server (then its own timestamp, verbatim: the server keeps microseconds).
    const floor = Date.now() - 30_000
    const recordedCutoff = Date.parse(completion.recordedAt) >= floor ? completion.recordedAt : new Date(floor).toISOString()
    const input = await loadEngineInput(crop, recordedCutoff)
    const origin = weekIndex(completion.year, completion.week)
    const result = forecastForWeek(input, {
      originIndex: origin,
      cutoff: recordedCutoff,
      observedCutoff: completion.observedAt,
      horizon: FORECAST_WEEKS,
      defaultBasis: DEFAULT_BASIS,
      validatedByBasis: validated,
    })
    const dataSummary = { ...result.dataSummary, afwHistory: input.afwHistory, basisSource: result.basisSource }
    const weeks = result.weeks.map((w) => {
      const t = weekOfIndex(w.targetIndex)
      const a = w.available
      // A week the basis can't support is stored without numbers.
      return {
        horizon: w.horizon,
        target_year: t.year,
        target_week: t.week,
        window: w.window,
        available: a,
        sample_fruit: a ? w.sampleFruit : null,
        sample_variance: a ? w.sampleVariance : null,
        crop_fruit: a ? w.cropFruit : null,
        components: a ? w.components : null,
        expected_aborted: a ? w.expectedAborted : null,
        expected_pruned: a ? w.expectedPruned : null,
        afw_g: a ? w.afwG : null,
        afw_source: a ? w.afwSource : null,
        afw_kind: a ? w.afwKind : null,
        kg: a ? w.kg : null,
      }
    })
    const rows = check(
      await supabase.rpc('lock_forecast_run', {
        p_run_id: crypto.randomUUID(),
        p_crop_id: crop.id,
        p_origin_year: completion.year,
        p_origin_week: completion.week,
        p_sampling_event_id: completion.id,
        p_recorded_cutoff: recordedCutoff,
        p_horizon: FORECAST_WEEKS,
        p_marketing_weeks: MARKETING_WEEKS,
        p_engine_version: result.engineVersion,
        p_confidence: result.confidence.level,
        p_confidence_reasons: result.confidence.reasons,
        p_model: { params: result.params, inventoryFate: result.inventoryFate, newSetsPerWeek: result.newSetsPerWeek },
        p_data_summary: dataSummary,
        p_sample_stems: result.sampleStems,
        p_sample_stem_ids: result.sampleStemIds,
        p_scale: result.scale,
        p_marketing: { sample_fruit: result.marketingTotal.sampleFruit, crop_fruit: result.marketingTotal.cropFruit, kg: result.marketingTotal.kg },
        p_weeks: weeks,
        p_basis: result.basis,
        p_harvest_ready_share: result.harvestReadyShare,
        p_breaker_breakdown: result.breakers,
        p_coverage: result.coverage.share,
      }),
    )
    return rows[0]
  }

  // ── Live accuracy and the historical replay ────────────────────────────────

  /** Sampling coverage per week index (sampling_weeks) for the given ISO years. */
  async function loadSampling(cropId: string, years: number[]): Promise<Map<number, SamplingWeek>> {
    const map = new Map<number, SamplingWeek>()
    for (const year of years) {
      const rows = check(await supabase.rpc('sampling_weeks', { p_crop_id: cropId, p_year: year }))
      for (const r of rows) map.set(weekIndex(year, r.iso_week), { visited: r.visited_stems, expected: r.expected_stems, complete: r.state === 'complete' })
    }
    return map
  }

  /** Every locked forecast of the crop with its weeks, scored against what has been recorded since. */
  async function loadLiveAccuracy(crop: Crop): Promise<LiveAccuracyResult> {
    const now = new Date().toISOString()
    const current = greenhouseWeekIndex(new Date())
    // Each sampling week is scored by the version that counts: its latest revision (earlier ones are kept, not scored).
    const runs = latestRevisions(check(await supabase.from('forecast_runs').select('*').eq('crop_id', crop.id)))
    const weeks = runs.length ? check(await supabase.from('forecast_run_weeks').select('*').in('run_id', runs.map((r) => r.id))) : []
    const liveRuns: LiveRun[] = runs.map((r) => ({
      id: r.id,
      originIndex: weekIndex(r.origin_year, r.origin_week),
      kind: r.kind,
      confidence: r.confidence,
      sampleStemIds: r.sample_stem_ids,
      scale: Number(r.scale),
      basis: r.basis,
      harvestReadyShare: num(r.harvest_ready_share),
      coverage: num(r.coverage),
      weeks: weeks
        .filter((w) => w.run_id === r.id)
        .sort((a, b) => a.horizon - b.horizon)
        .map((w) => ({
          horizon: w.horizon,
          targetIndex: weekIndex(w.target_year, w.target_week),
          window: w.window,
          available: w.available,
          sampleFruit: Number(w.sample_fruit ?? 0),
          kg: num(w.kg),
          afwG: num(w.afw_g),
        })),
    }))
    const years = [...new Set([weekOfIndex(current).year, ...weeks.map((w) => w.target_year)])]
    const [input, sampling, afw, actualKg] = await Promise.all([
      loadEngineInput(crop, now),
      loadSampling(crop.id, years),
      supabase.from('weekly_harvest_afw').select('year, week, afw_g').eq('crop_id', crop.id).then(check),
      loadActualKg(crop.id),
    ])
    const live = liveAccuracy(
      {
        currentIndex: current,
        history: buildHistory(input, current, now),
        sampling,
        flags: input.flags,
        actualAfw: new Map(afw.map((a) => [weekIndex(a.year, a.week), Number(a.afw_g)])),
        actualKg,
      },
      liveRuns,
    )
    return {
      ...live,
      validatedByBasis: {
        // Lifecycle: validated on Harvested records (and, separately, shown against actual kg); Breakers only: on actual kg.
        lifecycle: live.accuracy.validatedHorizons,
        breaker_only: live.actual.validatedHorizons.breaker_only,
      },
    }
  }


  return {
    loadEngineInput,
    loadBasisSettings,
    loadActualKg,
    latestCompletion,
    computePreview,
    inputSignature,
    generatePreview,
    latestPreview,
    lockForecast,
    loadLiveAccuracy,
  }
}

export type ForecastData = ReturnType<typeof createForecastData>
