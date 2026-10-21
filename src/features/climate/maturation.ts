// Maturation study (research, read-only): Breaker → Harvested per fruit, with
// the variety's climate over that period. Nothing here feeds the forecast.
//
// Fruit: the first BreakerFruit record and the first Harvested record of the
// same node. Both are observations at weekly-ish visits, so each transition is
// an interval:
//   breaker started   after the last time this fruit was seen not yet Breaker (Vb), by the Breaker record (B);
//                     only when the fruit has an earlier record (else its start is unknown)
//   picked            after the last time this fruit was seen still on the plant (Vh), by the Harvested record (H)
// "Seen" means the fruit's own record, or a "✓ Stem checked" of its stem (every node looked at).
// Records of other fruits on the stem don't count: they don't show this fruit was checked.
// Windows (greenhouse-local dates, end exclusive):
//   shortest  B  → Vh      (turned Breaker as late, picked as early as possible)
//   longest   Vb → H       (turned Breaker as early, picked as late as possible)
//   central   mid(Vb,B) → mid(Vh,H)   a central estimate, not a measurement
// Climate (the canonical variety values: crop_climate_hourly / crop_climate_daily):
//   temperature  °C·days = sum of the window's daily mean temperatures, only when
//                ≥ 90 % of expected hourly readings exist and no day is empty
//   radiation    sum of daily 23:00 finals, only when every day has one
//   means        temperature, RH and CO₂ over the window's hourly readings
// Missing readings are never filled; a fruit without enough climate is counted, not used.

import { hoursInDay, addDays } from './reports'

export type StudyObservation = { id: string; plant_node_id: string; status: string; observed_at: string; recorded_at: string; created_by: string | null }
export type StudyNode = { id: string; measurement_stem_id: string; is_active: boolean }
/** Node-level data-quality flags (crop_quality_flags) with their review decision. */
export type StudyFlag = { node: string; rule_id: string; review_decision: string | null }
/** One day's mean of the hourly values present, and how many hours that is (crop_climate_daily). */
export type DayMean = { mean: number; hours: number }
/** Greenhouse-local date → daily means (temperature, RH, CO₂) and the daily radiation final. */
export type StudyClimate = {
  daily: Map<string, { temp?: DayMean; rh?: DayMean; co2?: DayMean }>
  radiationFinal: Map<string, number>
}

export const MIN_TEMP_COVERAGE = 0.9
/** Flags that make a fruit's identity or sequence unreliable (unless reviewed as legitimate). */
const EXCLUDING_FLAGS = new Set(['stage_regression', 'harvest_without_ripening'])
const ON_PLANT_BEFORE = new Set(['Flower', 'SetFruit', 'MatureGreen'])

export type Exclusion =
  | 'harvest_before_breaker'
  | 'same_visit'
  | 'invalid_sequence'
  | 'no_visit_before_breaker'
  | 'flagged_unreliable'
  | 'reviewed_recording_error'
  | 'node_deactivated'

export type WindowClimate = {
  start: string
  end: string
  days: number
  tempCoverage: number | null
  degreeDays: number | null
  radiation: number | null
  meanTemp: number | null
  meanRh: number | null
  meanCo2: number | null
}

export type Fruit = {
  node: string
  legacy: boolean
  breakerRecord: string
  harvestRecord: string
  visitBeforeBreaker: string | null
  visitBeforeHarvest: string | null
  excluded: Exclusion | null
  shortest: WindowClimate | null
  central: WindowClimate | null
  longest: WindowClimate | null
}

/** "2026-10-14T16:00:00Z" → its greenhouse-local date. */
export function localDateOf(iso: string, timeZone: string): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(iso)).map((x) => [x.type, x.value]),
  )
  return `${p.year}-${p.month}-${p.day}`
}

const dayNumber = (d: string) => Date.parse(`${d}T00:00:00Z`) / 86_400_000
const dateOfNumber = (n: number) => new Date(n * 86_400_000).toISOString().slice(0, 10)

export function windowClimate(start: string, end: string, climate: StudyClimate, timeZone: string): WindowClimate {
  const days: string[] = []
  for (let d = start; d < end; d = addDays(d, 1)) days.push(d)
  if (days.length === 0) return { start, end, days: 0, tempCoverage: null, degreeDays: 0, radiation: 0, meanTemp: null, meanRh: null, meanCo2: null }
  const expected = days.reduce((s, d) => s + hoursInDay(d, timeZone), 0)
  const temps = days.map((d) => climate.daily.get(d)?.temp)
  const recorded = temps.reduce((s, t) => s + (t?.hours ?? 0), 0)
  const coverage = recorded / expected
  const tempOk = coverage >= MIN_TEMP_COVERAGE && temps.every((t) => t && t.hours > 0)
  const finals = days.map((d) => climate.radiationFinal.get(d))
  // The mean of all the window's hourly readings (hour-weighted daily means).
  const hourly = (k: 'temp' | 'rh' | 'co2') => {
    const ds = days.map((d) => climate.daily.get(d)?.[k]).filter((x): x is DayMean => !!x && x.hours > 0)
    const h = ds.reduce((s, x) => s + x.hours, 0)
    return h ? ds.reduce((s, x) => s + x.mean * x.hours, 0) / h : null
  }
  return {
    start,
    end,
    days: days.length,
    tempCoverage: coverage,
    degreeDays: tempOk ? temps.reduce((s, t) => s + t!.mean, 0) : null,
    radiation: finals.every((f) => f !== undefined) ? finals.reduce((s, f) => s + f!, 0) : null,
    meanTemp: tempOk ? hourly('temp') : null,
    meanRh: tempOk ? hourly('rh') : null,
    meanCo2: tempOk ? hourly('co2') : null,
  }
}

/** Every Breaker → Harvested fruit of a variety, matched, bounded, checked and with its climate. */
export function studyFruits(
  observations: readonly StudyObservation[],
  nodes: readonly StudyNode[],
  /** Stem → greenhouse-local dates of explicit "✓ Stem checked" (every node of the stem looked at). */
  stemChecks: Map<string, Set<string>>,
  flags: readonly StudyFlag[],
  climate: StudyClimate,
  timeZone: string,
): Fruit[] {
  const nodeById = new Map(nodes.map((n) => [n.id, n]))
  const byNode = new Map<string, StudyObservation[]>()
  for (const o of observations) (byNode.get(o.plant_node_id) ?? byNode.set(o.plant_node_id, []).get(o.plant_node_id)!).push(o)
  const flagsByNode = new Map<string, StudyFlag[]>()
  for (const f of flags) (flagsByNode.get(f.node) ?? flagsByNode.set(f.node, []).get(f.node)!).push(f)
  const isLegacy = (o: StudyObservation) => o.created_by === null && o.recorded_at === o.observed_at

  const fruits: Fruit[] = []
  for (const [nodeId, list] of byNode) {
    const seq = [...list].sort((a, b) => a.observed_at.localeCompare(b.observed_at))
    const b = seq.find((o) => o.status === 'BreakerFruit')
    const h = seq.find((o) => o.status === 'Harvested')
    if (!b || !h) continue
    const node = nodeById.get(nodeId)
    const bDate = localDateOf(b.observed_at, timeZone)
    const hDate = localDateOf(h.observed_at, timeZone)
    const seen = [...new Set([...seq.map((o) => localDateOf(o.observed_at, timeZone)), ...(node ? stemChecks.get(node.measurement_stem_id) ?? [] : [])])].sort()
    // The Breaker start is bounded only when the fruit itself was recorded before (a stem visit
    // before its first record says nothing about this fruit).
    const seenBefore = seq.some((o) => o.observed_at < b.observed_at)
    const vb = seenBefore ? seen.filter((d) => d < bDate).pop() ?? null : null
    const vh = seen.filter((d) => d < hDate).pop() ?? null
    const nodeFlags = flagsByNode.get(nodeId) ?? []
    let excluded: Exclusion | null = null
    if (h.observed_at <= b.observed_at) excluded = 'harvest_before_breaker'
    // Breaker and Harvested at the same visit: a correction, not a transition that can be timed.
    else if (bDate === hDate) excluded = 'same_visit'
    else if (seq.some((o) => o.observed_at > b.observed_at && o.observed_at < h.observed_at && (ON_PLANT_BEFORE.has(o.status) || o.status === 'Aborted' || o.status === 'Pruned')) || seq.some((o) => o.observed_at > h.observed_at && o.status !== 'Harvested'))
      excluded = 'invalid_sequence'
    else if (nodeFlags.some((f) => f.review_decision === 'recording_error')) excluded = 'reviewed_recording_error'
    else if (nodeFlags.some((f) => EXCLUDING_FLAGS.has(f.rule_id) && f.review_decision !== 'legitimate')) excluded = 'flagged_unreliable'
    else if (node && !node.is_active) excluded = 'node_deactivated'
    else if (!vb) excluded = 'no_visit_before_breaker'
    const legacy = isLegacy(b) || isLegacy(h)
    const fruit: Fruit = { node: nodeId, legacy, breakerRecord: bDate, harvestRecord: hDate, visitBeforeBreaker: vb, visitBeforeHarvest: vh, excluded, shortest: null, central: null, longest: null }
    if (!excluded && vb && vh) {
      const mid = (a: string, z: string) => dateOfNumber(Math.round((dayNumber(a) + dayNumber(z)) / 2))
      fruit.shortest = windowClimate(bDate, vh > bDate ? vh : bDate, climate, timeZone)
      fruit.longest = windowClimate(vb, hDate, climate, timeZone)
      fruit.central = windowClimate(mid(vb, bDate), mid(vh, hDate), climate, timeZone)
    }
    fruits.push(fruit)
  }
  return fruits.sort((a, b) => a.breakerRecord.localeCompare(b.breakerRecord) || a.node.localeCompare(b.node))
}

export type Summary = { n: number; median: number | null; mean: number | null; min: number | null; max: number | null; cv: number | null }

export function summarize(values: number[]): Summary {
  const xs = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b)
  if (xs.length === 0) return { n: 0, median: null, mean: null, min: null, max: null, cv: null }
  const m = xs.reduce((s, x) => s + x, 0) / xs.length
  const sd = xs.length > 1 ? Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1)) : null
  const median = xs.length % 2 ? xs[(xs.length - 1) / 2] : (xs[xs.length / 2 - 1] + xs[xs.length / 2]) / 2
  return { n: xs.length, median, mean: m, min: xs[0], max: xs[xs.length - 1], cv: sd !== null && m !== 0 ? sd / Math.abs(m) : null }
}

export type StudyResult = {
  fruits: number
  excluded: Partial<Record<Exclusion, number>>
  usable: number
  withTemperature: number
  withRadiation: number
  days: Summary
  shortestDays: Summary
  longestDays: Summary
  degreeDays: Summary
  degreeDaysShortest: Summary
  degreeDaysLongest: Summary
  radiation: Summary
  meanTemp: Summary
  meanRh: Summary
  meanCo2: Summary
}

/** A variety's results: the central estimate and its plausible range (shortest/longest windows). */
export function studyResult(fruits: readonly Fruit[], includeLegacy: boolean): StudyResult {
  const set = fruits.filter((f) => includeLegacy || !f.legacy)
  const excluded: Partial<Record<Exclusion, number>> = {}
  for (const f of set) if (f.excluded) excluded[f.excluded] = (excluded[f.excluded] ?? 0) + 1
  const usable = set.filter((f) => !f.excluded && f.central)
  // A window of no whole day carries no climate information.
  const withT = usable.filter((f) => f.central!.degreeDays !== null && f.central!.days > 0)
  const withR = usable.filter((f) => f.central!.radiation !== null && f.central!.days > 0)
  return {
    fruits: set.length,
    excluded,
    usable: usable.length,
    withTemperature: withT.length,
    withRadiation: withR.length,
    days: summarize(usable.map((f) => f.central!.days)),
    shortestDays: summarize(usable.map((f) => f.shortest!.days)),
    longestDays: summarize(usable.map((f) => f.longest!.days)),
    degreeDays: summarize(withT.map((f) => f.central!.degreeDays!)),
    degreeDaysShortest: summarize(withT.filter((f) => f.shortest!.degreeDays !== null).map((f) => f.shortest!.degreeDays!)),
    degreeDaysLongest: summarize(withT.filter((f) => f.longest!.degreeDays !== null).map((f) => f.longest!.degreeDays!)),
    radiation: summarize(withR.map((f) => f.central!.radiation!)),
    meanTemp: summarize(withT.map((f) => f.central!.meanTemp!)),
    meanRh: summarize(withT.map((f) => f.central!.meanRh!)),
    meanCo2: summarize(withT.map((f) => f.central!.meanCo2!)),
  }
}
