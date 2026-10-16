// Rolling-origin backtest: for each past week, forecast the next five weeks
// from what had been recorded by the end of that week (records, flags and
// reviews as of then), then score against what was recorded later.
//
// Only one thing is known with hindsight and stated as such: AFWs entered
// for weeks up to the origin are assumed to have been entered on time (the
// table keeps no history yet). AFWs typed for later weeks are never used.

import { metrics, scoringUnits, type Metrics, type ScoringUnit, type ScoringWeek } from './accuracy'
import { forecastAfw } from './afw'
import { baselineForecast, type BaselineId } from './baselines'
import { forecast } from './forecast'
import { buildHistory } from './history'
import type { EngineFlag, EngineInput, ModelParams } from './types'
import { DEFAULT_PARAMS, FORECAST_WEEKS, MARKETING_WEEKS } from './types'
import { weekIndex, weekStartInstant } from './weeks'

export type Candidate =
  | { id: string; label: string; kind: 'model'; params: Partial<ModelParams> }
  | { id: string; label: string; kind: 'baseline'; baseline: BaselineId }

export type BacktestData = {
  /** Raw records (flags are supplied per origin). */
  input: Omit<EngineInput, 'flags'>
  /** crop_quality_flags(crop, cutoff of each origin). */
  flagsAsOf: Map<number, EngineFlag[]>
  /** Flags as they stand now, used only to decide which observed weeks are unreliable for scoring. */
  finalFlags: EngineFlag[]
  origins: number[]
  /** The last week whose observed harvest can be scored (complete and followed by a visit). */
  lastScoreable: number
}

/** The end of an origin week (Sunday 23:59:59.999 Toronto): its forecast's data cutoff. */
export const originCutoff = (originIndex: number) => new Date(weekStartInstant(originIndex + 1).getTime() - 1).toISOString()

export const UNRELIABLE_RULES = ['harvest_not_recorded', 'incomplete_visit']

export type OriginResult = { originIndex: number; weeks: ScoringWeek[]; units: ScoringUnit[] }

export type CandidateReport = {
  candidate: Candidate
  origins: OriginResult[]
  /** One entry per horizon, 1 … FORECAST_WEEKS. */
  fruitByHorizon: Metrics[]
  kgByHorizon: Metrics[]
  /** Weeks 1–5 summed (the marketing total), origins whose five weeks are all scoreable. */
  marketingFruit: Metrics
  marketingKg: Metrics
  /** All forecast weeks summed, origins whose weeks are all scoreable. */
  allWeeksFruit: Metrics
  allWeeksKg: Metrics
  blocks: number
}

export function runBacktest(data: BacktestData, candidates: Candidate[], horizon = FORECAST_WEEKS) {
  const unreliable = new Set(
    data.finalFlags
      .filter((f) => UNRELIABLE_RULES.includes(f.ruleId) && f.reviewDecision !== 'legitimate')
      .map((f) => weekIndex(Math.floor(f.yw / 100), f.yw % 100)),
  )
  // What was eventually recorded (all data, as recorded; nothing excluded).
  const final = buildHistory({ ...data.input, flags: [] }, Number.MAX_SAFE_INTEGER, '9999-12-31T00:00:00Z')
  const afwOf = new Map(data.input.afw.map((a) => [weekIndex(a.year, a.week), a.afwG]))

  const reports: CandidateReport[] = candidates.map((candidate) => {
    const origins: OriginResult[] = []
    for (const o of data.origins) {
      const cutoff = originCutoff(o)
      const input: EngineInput = { ...data.input, flags: data.flagsAsOf.get(o) ?? [] }
      const asOf = buildHistory(input, o, cutoff, candidate.kind === 'model' ? (candidate.params.assumeConfirmed ?? []) : [])
      const stems = new Set(asOf.sampleStemIds)
      const scale = stems.size ? data.input.crop.pickingStems / stems.size : 0
      // No grower AFW in backtests: the AFW table has no history, so a value for a target week may have been typed later.
      const params = { ...DEFAULT_PARAMS, ...(candidate.kind === 'model' ? candidate.params : {}), growerAfw: false }
      let fruit: number[]
      let kg: (number | null)[]
      if (candidate.kind === 'model') {
        const f = forecast(input, { originIndex: o, cutoff, horizon, params: { ...candidate.params, growerAfw: false } })
        fruit = f.weeks.map((w) => w.sampleFruit)
        kg = f.weeks.map((w) => w.kg)
      } else {
        fruit = baselineForecast(asOf, candidate.baseline, horizon)
        kg = fruit.map((n, k) => {
          const afw = forecastAfw(data.input.afw, o, o + k + 1, params.afwMethod)
          return afw ? (n * scale * afw.grams) / 1000 : null
        })
      }
      const weeks: ScoringWeek[] = fruit.map((f, k) => {
        const index = o + k + 1
        const observed = final.nodes.filter((h) => h.harvestIndex === index && stems.has(h.stemId)).length
        const afw = afwOf.get(index)
        return { index, horizon: k + 1, forecastFruit: f, observedFruit: observed, forecastKg: kg[k], observedKg: afw === undefined ? null : (observed * scale * afw) / 1000 }
      })
      origins.push({ originIndex: o, weeks, units: scoringUnits(weeks, unreliable, data.lastScoreable) })
    }

    const units = origins.flatMap((r) => r.units)
    const byHorizon = (h: number, key: 'fruit' | 'kg') =>
      metrics(
        units
          .filter((u) => u.horizon === h && (key === 'fruit' || (u.forecastKg !== null && u.observedKg !== null)))
          .map((u) => (key === 'fruit' ? { forecast: u.forecastFruit, observed: u.observedFruit } : { forecast: u.forecastKg!, observed: u.observedKg! })),
      )
    // Totals over the first n weeks, for origins whose n weeks can all be scored (a trailing unreliable week would cut off its catch-up).
    const totals = (n: number) => {
      const complete = origins.map((r) => r.weeks.slice(0, n)).filter((ws) => ws.every((w) => w.index <= data.lastScoreable) && !unreliable.has(ws[ws.length - 1].index))
      return {
        fruit: metrics(complete.map((ws) => ({ forecast: sum(ws.map((w) => w.forecastFruit)), observed: sum(ws.map((w) => w.observedFruit)) }))),
        kg: metrics(
          complete
            .filter((ws) => ws.every((w) => w.forecastKg !== null && w.observedKg !== null))
            .map((ws) => ({ forecast: sum(ws.map((w) => w.forecastKg!)), observed: sum(ws.map((w) => w.observedKg!)) })),
        ),
      }
    }
    const marketing = totals(Math.min(MARKETING_WEEKS, horizon))
    const all = totals(horizon)
    return {
      candidate,
      origins,
      fruitByHorizon: Array.from({ length: horizon }, (_, k) => byHorizon(k + 1, 'fruit')),
      kgByHorizon: Array.from({ length: horizon }, (_, k) => byHorizon(k + 1, 'kg')),
      marketingFruit: marketing.fruit,
      marketingKg: marketing.kg,
      allWeeksFruit: all.fruit,
      allWeeksKg: all.kg,
      blocks: units.filter((u) => u.block).length,
    }
  })
  return { reports, unreliable: [...unreliable].sort((a, b) => a - b) }
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0)
