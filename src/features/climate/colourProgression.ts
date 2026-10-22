// Research: colour progression toward harvest, from post-harvest inspections.
//
// Each colour measurement (a Breaker's photo pair, colour % estimated and
// possibly corrected by a person) of a fruit whose harvest date is known —
// inferred from a complete inspection or confirmed by a person — gives one
// point: colour % at the photo, and the days, °C·days and J/cm² from the photo
// day (included) to the harvest day (excluded), in whole greenhouse days with
// the variety's daily climate (same coverage rules as the Breaker → Harvested
// study). Harvests are dates without a time and the photo's time of day isn't
// used, so the true interval is uncertain by up to a day either way. Fruit
// without a dated harvest are left out: no harvest date or time is guessed.
// Read-only; it does not feed the forecast.

import { localDateOf, summarize, windowClimate, type StudyClimate, type Summary, type WindowClimate } from './maturation'

export type ColourAnalysis = {
  id: string
  node_observation_id: string
  kind: 'automatic' | 'manual' | 'correction'
  combined_percent: number
  confidence: number | null
  supersedes_id: string | null
  created_at: string
}

/**
 * The estimate in effect for each observation: the newest by a person (manual
 * or correction) when there is one, otherwise the newest automatic one. A
 * person's correction always wins over the automatic estimate; nothing is
 * overwritten.
 */
export function analysesInEffect(analyses: readonly ColourAnalysis[]): Map<string, ColourAnalysis> {
  const result = new Map<string, ColourAnalysis>()
  const rank = (a: ColourAnalysis) => (a.kind === 'automatic' ? 0 : 1)
  for (const a of analyses) {
    const cur = result.get(a.node_observation_id)
    if (!cur || rank(a) > rank(cur) || (rank(a) === rank(cur) && a.created_at > cur.created_at)) result.set(a.node_observation_id, a)
  }
  return result
}

export type ColourMeasurement = { node: string; stem: string; observationId: string; at: string; percent: number; byPerson: boolean; confidence: number | null }
export type DatedHarvest = { node: string; harvestDate: string; status: 'inferred' | 'confirmed'; minColour: number | null }

export type ProgressionPoint = ColourMeasurement & {
  date: string
  harvestDate: string
  linkStatus: 'inferred' | 'confirmed'
  /** The harvest's intended minimum colour (the pickers' target, not this fruit's colour). */
  minColour: number | null
  /** The fruit's last measurement before its harvest ("colour near harvest"). */
  lastBeforeHarvest: boolean
  toHarvest: WindowClimate
}

/** One point per colour measurement made before its fruit's dated harvest. */
export function progressionPoints(measurements: readonly ColourMeasurement[], harvests: readonly DatedHarvest[], climate: StudyClimate, timeZone: string): ProgressionPoint[] {
  const byNode = new Map(harvests.map((h) => [h.node, h]))
  const points: ProgressionPoint[] = []
  for (const m of measurements) {
    const h = byNode.get(m.node)
    if (!h) continue
    const date = localDateOf(m.at, timeZone)
    if (date > h.harvestDate) continue
    points.push({ ...m, date, harvestDate: h.harvestDate, linkStatus: h.status, minColour: h.minColour, lastBeforeHarvest: false, toHarvest: windowClimate(date, h.harvestDate, climate, timeZone) })
  }
  const last = new Map<string, ProgressionPoint>()
  for (const p of points) {
    const cur = last.get(p.node)
    if (!cur || p.at > cur.at) last.set(p.node, p)
  }
  for (const p of last.values()) p.lastBeforeHarvest = true
  return points.sort((a, b) => a.at.localeCompare(b.at))
}

export const BANDS: readonly { label: string; from: number; to: number }[] = [
  { label: '0–24%', from: 0, to: 25 },
  { label: '25–49%', from: 25, to: 50 },
  { label: '50–74%', from: 50, to: 75 },
  { label: '75–100%', from: 75, to: 101 },
]
export const bandOf = (percent: number) => BANDS.findIndex((b) => percent >= b.from && percent < b.to)

export type Measure = 'days' | 'degreeDays' | 'radiation'
const value = (p: ProgressionPoint, m: Measure) => (m === 'days' ? p.toHarvest.days : m === 'degreeDays' ? p.toHarvest.degreeDays : p.toHarvest.radiation)

export type BandSummary = { label: string; fruit: number; points: number; days: Summary; degreeDays: Summary; radiation: Summary }

/** Time to harvest by colour band at the photo. */
export function bandSummaries(points: readonly ProgressionPoint[]): BandSummary[] {
  return BANDS.map((b, i) => {
    const ps = points.filter((p) => bandOf(p.percent) === i)
    const of = (m: Measure) => summarize(ps.map((p) => value(p, m)).filter((v): v is number => v !== null))
    return { label: b.label, fruit: new Set(ps.map((p) => p.node)).size, points: ps.length, days: of('days'), degreeDays: of('degreeDays'), radiation: of('radiation') }
  })
}

export const MIN_TRAIN = 8
export const MIN_TEST = 4

export type Evaluation = {
  split: 'later_dates' | 'held_out_stems'
  description: string
  train: number
  test: number
  /** Mean absolute error ÷ mean actual (lower = better), per measure; null when too few points have it. */
  relativeError: Record<Measure, number | null>
}

/**
 * Predicts time to harvest from the colour band (the band's median in the
 * training points) and scores it on points the prediction never saw:
 *   later_dates     trained on fruit harvested on the earlier 70% of harvest
 *                   dates, tested on the later ones;
 *   held_out_stems  trained on every other sampled stem, tested on the rest
 *                   (fruit on one stem are not independent).
 * Errors are relative, so days, °C·days and J/cm² can be compared.
 */
export function evaluate(points: readonly ProgressionPoint[]): Evaluation[] {
  const results: Evaluation[] = []
  const dates = [...new Set(points.map((p) => p.harvestDate))].sort()
  if (dates.length >= 2) {
    const cut = dates[Math.max(1, Math.floor(dates.length * 0.7)) - 1]
    results.push(score('later_dates', `trained on harvests up to ${cut}, tested on later ones`, points.filter((p) => p.harvestDate <= cut), points.filter((p) => p.harvestDate > cut)))
  }
  const stems = [...new Set(points.map((p) => p.stem))].sort()
  if (stems.length >= 2) {
    const held = new Set(stems.filter((_, i) => i % 2 === 1))
    results.push(score('held_out_stems', `trained on ${stems.length - held.size} stems, tested on the other ${held.size}`, points.filter((p) => !held.has(p.stem)), points.filter((p) => held.has(p.stem))))
  }
  return results
}

function score(split: Evaluation['split'], description: string, train: readonly ProgressionPoint[], test: readonly ProgressionPoint[]): Evaluation {
  const relativeError = {} as Record<Measure, number | null>
  for (const m of ['days', 'degreeDays', 'radiation'] as const) {
    const medians = BANDS.map((_, i) => summarize(train.filter((p) => bandOf(p.percent) === i).map((p) => value(p, m)).filter((v): v is number => v !== null)))
    const trainN = train.filter((p) => value(p, m) !== null).length
    const pairs = test
      .map((p) => ({ actual: value(p, m), predicted: medians[bandOf(p.percent)]?.median ?? null }))
      .filter((x): x is { actual: number; predicted: number } => x.actual !== null && x.predicted !== null)
    const meanActual = pairs.reduce((s, x) => s + x.actual, 0) / (pairs.length || 1)
    relativeError[m] =
      trainN >= MIN_TRAIN && pairs.length >= MIN_TEST && meanActual > 0
        ? pairs.reduce((s, x) => s + Math.abs(x.predicted - x.actual), 0) / pairs.length / meanActual
        : null
  }
  return { split, description, train: train.length, test: test.length, relativeError }
}
