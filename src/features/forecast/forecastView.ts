// One shape for what the Harvest Forecast tab shows, whether it comes from a
// locked snapshot (forecast_runs) or a preview computed in the browser.

import type { ForecastRunRow, ForecastRunWeekRow } from '../../lib/database.types'
import type { Preview } from './api'
import type { BreakerBreakdown, DataSummary, ForecastBasis } from './engine/types'
import { MARKETING_WEEKS } from './engine/types'
import { weekOfIndex } from './engine/weeks'

export type ViewWeek = {
  horizon: number
  year: number
  week: number
  window: 'marketing' | 'outlook'
  /** False: the basis can't support this week; it has no numbers (shown as Not available). */
  available: boolean
  unavailableReason: string | null
  sampleFruit: number | null
  cropFruit: number | null
  afwG: number | null
  afwSource: string | null
  afwKind: 'grower' | 'model' | null
  kg: number | null
  cases: number | null
  components: { breaker: number; matureGreen: number; setFruit: number; catchUp: number; newSets: number } | null
  expectedAborted: number | null
  expectedPruned: number | null
}

const NOT_AVAILABLE = 'Not available'

export type ForecastView = {
  source: 'locked' | 'preview'
  /** Locked: 'official' (on time) or 'late'. Preview: 'preliminary' (sampling not complete) or 'preview'. */
  status: 'official' | 'late' | 'preliminary' | 'preview'
  runId: string | null
  originYear: number
  originWeek: number
  /** When it was locked or computed. */
  at: string
  observedCutoff: string
  recordedCutoff: string
  engineVersion: string
  confidence: { level: 'experimental' | 'standard'; reasons: string[] }
  sampleStems: number
  scale: number
  caseWeightKg: number | null
  weeks: ViewWeek[]
  marketing: { weeks: number; cropFruit: number | null; kg: number | null; cases: number | null }
  basis: ForecastBasis
  /** Breakers only: the harvest-ready share used. */
  harvestReadyShare: number | null
  breakers: BreakerBreakdown | null
  /** Stems checked or recorded that week of those in the sample (visited unknown for older locked forecasts). */
  coverage: { visited: number | null; expected: number; share: number | null }
  /** Fruit on the plants at the origin (crop scale): expected harvested within the forecast, aborted, pruned, still on the plant after it. */
  fate: { harvested: number; aborted: number; pruned: number; stillOnPlant: number } | null
  dataSummary: (DataSummary & { afwHistory?: 'log' | 'current' }) | null
  model: unknown
}

const cases = (kg: number | null, caseWeight: number | null) => (kg === null || !caseWeight ? null : kg / caseWeight)

type Fate = { harvested: number; aborted: number; pruned: number; stillOnPlant: { S: number; M: number; B: number } }
const fateAtScale = (f: Fate | undefined, scale: number) =>
  f ? { harvested: f.harvested * scale, aborted: f.aborted * scale, pruned: f.pruned * scale, stillOnPlant: (f.stillOnPlant.S + f.stillOnPlant.M + f.stillOnPlant.B) * scale } : null

export function viewFromPreview(p: Preview, caseWeightKg: number | null): ForecastView {
  const r = p.result
  const weeks: ViewWeek[] = r.weeks.map((w) => {
    const t = weekOfIndex(w.targetIndex)
    const a = w.available
    return {
      horizon: w.horizon,
      year: t.year,
      week: t.week,
      window: w.window,
      available: a,
      unavailableReason: w.unavailableReason,
      sampleFruit: a ? w.sampleFruit : null,
      cropFruit: a ? w.cropFruit : null,
      afwG: a ? w.afwG : null,
      afwSource: a ? w.afwSource : null,
      afwKind: a ? w.afwKind : null,
      kg: a ? w.kg : null,
      cases: a ? cases(w.kg, caseWeightKg) : null,
      components: a ? w.components : null,
      expectedAborted: a ? w.expectedAborted : null,
      expectedPruned: a ? w.expectedPruned : null,
    }
  })
  return {
    source: 'preview',
    status: p.completion ? 'preview' : 'preliminary',
    runId: null,
    originYear: p.origin.year,
    originWeek: p.origin.week,
    at: p.computedAt,
    observedCutoff: r.dataSummary.observedCutoff,
    recordedCutoff: r.dataSummary.recordedCutoff,
    engineVersion: r.engineVersion,
    confidence: r.confidence,
    sampleStems: r.sampleStems,
    scale: r.scale,
    caseWeightKg,
    weeks,
    marketing: { weeks: r.marketingTotal.weeks, cropFruit: r.marketingTotal.cropFruit, kg: r.marketingTotal.kg, cases: cases(r.marketingTotal.kg, caseWeightKg) },
    basis: r.basis,
    harvestReadyShare: r.harvestReadyShare,
    breakers: r.breakers,
    coverage: r.coverage,
    fate: r.basis === 'lifecycle' && r.weeks.every((w) => w.available) ? fateAtScale(r.inventoryFate, r.scale) : null,
    dataSummary: { ...r.dataSummary, afwHistory: p.afwHistory },
    model: { params: r.params, newSetsPerWeek: r.newSetsPerWeek },
  }
}

export function viewFromRun(run: ForecastRunRow, rows: ForecastRunWeekRow[]): ForecastView {
  const model = run.model as { inventoryFate?: Fate } | null
  return {
    source: 'locked',
    status: run.kind,
    runId: run.id,
    originYear: run.origin_year,
    originWeek: run.origin_week,
    at: run.locked_at,
    observedCutoff: run.observed_cutoff,
    recordedCutoff: run.recorded_cutoff,
    engineVersion: run.engine_version,
    confidence: { level: run.confidence, reasons: run.confidence_reasons },
    sampleStems: run.sample_stems,
    scale: Number(run.scale),
    caseWeightKg: run.case_weight_kg === null ? null : Number(run.case_weight_kg),
    weeks: rows.map((w) => ({
      horizon: w.horizon,
      year: w.target_year,
      week: w.target_week,
      window: w.window,
      available: w.available,
      unavailableReason: w.available ? null : NOT_AVAILABLE,
      sampleFruit: w.sample_fruit,
      cropFruit: w.crop_fruit,
      afwG: w.afw_g,
      afwSource: w.afw_source,
      afwKind: w.afw_kind,
      kg: w.kg,
      cases: w.cases,
      components: w.components,
      expectedAborted: w.expected_aborted,
      expectedPruned: w.expected_pruned,
    })),
    marketing: {
      weeks: run.marketing_weeks,
      cropFruit: run.marketing_crop_fruit === null ? null : Number(run.marketing_crop_fruit),
      kg: run.marketing_kg,
      cases: cases(run.marketing_kg, run.case_weight_kg === null ? null : Number(run.case_weight_kg)),
    },
    basis: run.basis,
    harvestReadyShare: run.harvest_ready_share === null ? null : Number(run.harvest_ready_share),
    breakers: run.breaker_breakdown,
    coverage: {
      visited: run.basis === 'breaker_only' ? run.sample_stems : null,
      expected: run.basis === 'breaker_only' && run.coverage ? Math.round(run.sample_stems / Number(run.coverage)) : run.sample_stems,
      share: run.coverage === null ? null : Number(run.coverage),
    },
    fate: run.basis === 'lifecycle' && rows.every((w) => w.available) ? fateAtScale(model?.inventoryFate, Number(run.scale)) : null,
    dataSummary: run.data_summary as ForecastView['dataSummary'],
    model: run.model,
  }
}

export const STATUS_LABEL: Record<ForecastView['status'], string> = {
  official: 'Official',
  late: 'Late',
  preliminary: 'Preliminary',
  preview: 'Preliminary · sampling complete',
}

export function statusExplanation(v: Pick<ForecastView, 'status' | 'originWeek'>): string {
  switch (v.status) {
    case 'official':
      return `Locked from the completed W${v.originWeek} sampling before its first forecast week began. It will never change.`
    case 'late':
      return `Locked from the W${v.originWeek} sampling after its first forecast week had begun, so it is kept but not counted as an on-time forecast.`
    case 'preliminary':
      return `W${v.originWeek} sampling isn’t marked complete, so this preliminary forecast may change. It is saved and shown until it is generated again; it is never official and never counted in accuracy.`
    case 'preview':
      return `Computed from the completed W${v.originWeek} sampling and saved. Preliminary: the official forecast is the one locked when every sampled stem is checked.`
  }
}

/** Weeks 1–5 for the marketer, 6–8 the outlook. */
export const isMarketing = (w: Pick<ViewWeek, 'horizon'>) => w.horizon <= MARKETING_WEEKS

/** "1,234" */
export const formatCount = (n: number | null) => (n === null ? '—' : Math.round(n).toLocaleString('en-US'))
/** "1,234 kg" figures without unit. */
export const formatKg = formatCount

/** Hover text for a forecast week: where its expected harvest comes from (sample peppers). */
export function componentsTitle(w: ViewWeek, scale: number, basis: ForecastBasis = 'lifecycle'): string {
  if (!w.available || !w.components || w.sampleFruit === null) return w.unavailableReason ?? NOT_AVAILABLE
  if (basis === 'breaker_only') {
    return [
      `W${w.week}: ${w.sampleFruit.toFixed(1)} sampled peppers expected (${Math.round(w.sampleFruit * scale).toLocaleString('en-US')} for the crop)`,
      'From this week’s Breakers × the harvest-ready share',
      w.afwSource ? `AFW ${w.afwG?.toFixed(0)} g: ${w.afwSource}` : 'No AFW entered: kg not calculated',
    ].join('\n')
  }
  const c = w.components
  const crop = (n: number) => Math.round(n * scale).toLocaleString('en-US')
  const lines = [
    `W${w.week}: ${w.sampleFruit.toFixed(1)} sampled peppers expected (${crop(w.sampleFruit)} for the crop)`,
    `From fruit at Breaker now: ${c.breaker.toFixed(1)} · MatureGreen: ${c.matureGreen.toFixed(1)} · SetFruit: ${c.setFruit.toFixed(1)}`,
  ]
  if (c.catchUp > 0.05) lines.push(`Catch-up from stems not visited at the last sampling: ${c.catchUp.toFixed(1)}`)
  if (c.newSets > 0.05) lines.push(`Fruit not set yet: ${c.newSets.toFixed(1)}`)
  lines.push(`Fruit on the plants expected to abort this week: ${(w.expectedAborted ?? 0).toFixed(1)} · to be pruned: ${(w.expectedPruned ?? 0).toFixed(1)}`)
  if (w.afwSource) lines.push(`AFW ${w.afwG?.toFixed(0)} g: ${w.afwSource}`)
  return lines.join('\n')
}
