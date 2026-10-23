// Projections › Production Totals: the season's projected kg against actual
// harvested kg, per week and pepper colour. No forecasting formula of its own:
// it reads the forecasts already saved (locked forecasts and every saved
// preliminary version, all append-only) and the actual kg entered in Weekly
// Plant Data. Pure, so it can be tested.
//
// Which forecast stands for a variety and target week (never two added up):
//   * the target week has begun (completed or in progress): only forecasts
//     saved before it began (Monday 00:00 greenhouse time), so a forecast made
//     after the fact never counts; future weeks: every saved forecast.
//   * of those, the newest sampling week (origin); within a sampling week a
//     locked forecast (Official, else Late) over a preliminary one; within the
//     preliminary ones the newest saved version.
// Forecasts are never recalculated here. A forecast that says the week is not
// available (beyond what its basis supports) is no forecast for that week.
//
// Accuracy, error % = (projected − actual) / projected × 100: positive =
// overestimated, negative = underestimated. Only completed weeks count, and
// only variety-weeks with both a projected kg and an actual kg: the cards and
// every cell add up the same matched pairs for both. Missing values are never
// zero; they are counted and named instead.

import { weekIndex, weekOfIndex } from './engine/weeks'

export const GREENHOUSE_TZ = 'America/Toronto'
/** Future weeks shown: at most this many weeks after the current one. */
export const HORIZON_WEEKS = 8

export type HistoryCrop = { id: string; name: string; color: string; plantingDate: string; pulloutDate: string }

/** One target week of one saved forecast. */
export type Snapshot = {
  cropId: string
  targetYw: number
  originYw: number
  kind: 'official' | 'late' | 'preliminary'
  /** When it was saved (locked_at / created_at), ISO. */
  savedAt: string
  available: boolean
  /** Null: no AFW, so no kg. */
  kg: number | null
}

/** The actual kg in effect for a variety and week (the newest entry; null = cleared). */
export type Actual = { cropId: string; yw: number; kg: number | null; enteredAt: string }

export type Phase = 'completed' | 'current' | 'future'

export type ForecastMissing = 'no_forecast' | 'saved_after_start' | 'not_available' | 'afw_needed'
export type ActualMissing = 'not_entered' | 'in_progress' | 'future'

export type VarietyWeek = {
  crop: HistoryCrop
  forecast: Snapshot | null
  forecastMissing: ForecastMissing | null
  actualKg: number | null
  actualMissing: ActualMissing | null
  /** Completed week with both values: counts towards accuracy. */
  matched: boolean
}

export type Cell = {
  /** Varieties of this group in season that week. */
  expected: number
  /** Sum of the varieties that have a projected kg (null if none). */
  projected: number | null
  projectedComplete: boolean
  actual: number | null
  actualComplete: boolean
  /** Over the matched variety-weeks only (completed weeks). */
  matchedProjected: number
  matchedActual: number
  matchedCount: number
  errorPct: number | null
  kinds: Set<Snapshot['kind']>
  parts: VarietyWeek[]
}

export type HistoryRow = { yw: number; phase: Phase; byGroup: Map<string, Cell>; all: Cell }

export type Accuracy = {
  projected: number
  actual: number
  errorPct: number | null
  matched: number
  /** Completed in-season variety-weeks in the table. */
  expected: number
  excluded: { forecast: number; actual: number }
  weeks: number
}

// ── Weeks and time ───────────────────────────────────────────────────────────

const ywOf = (index: number) => {
  const w = weekOfIndex(index)
  return w.year * 100 + w.week
}
export const indexOfYw = (yw: number) => weekIndex(Math.floor(yw / 100), yw % 100)

const torontoHour = (ms: number) =>
  Number(new Intl.DateTimeFormat('en-US', { timeZone: GREENHOUSE_TZ, hour: 'numeric', hourCycle: 'h23' }).format(new Date(ms)))

/** Monday 00:00 greenhouse time of an ISO week, as epoch ms. */
export function weekStartsAt(yw: number): number {
  const monday = new Date((indexOfYw(yw) * 7 + 4) * 86_400_000)
  const [y, m, d] = [monday.getUTCFullYear(), monday.getUTCMonth(), monday.getUTCDate()]
  for (const offset of [4, 5, 3, 6]) {
    const t = Date.UTC(y, m, d, offset)
    if (torontoHour(t) === 0) return t
  }
  return Date.UTC(y, m, d, 5)
}

export function phaseOf(yw: number, currentYw: number): Phase {
  const i = indexOfYw(yw), c = indexOfYw(currentYw)
  return i < c ? 'completed' : i === c ? 'current' : 'future'
}

/** Monday (yyyy-mm-dd) of an ISO week, for the variety's season. */
const mondayIso = (yw: number) => new Date((indexOfYw(yw) * 7 + 4) * 86_400_000).toISOString().slice(0, 10)
export const inSeason = (crop: HistoryCrop, yw: number) => crop.plantingDate <= mondayIso(yw) && mondayIso(yw) <= crop.pulloutDate

// ── Choosing the forecast ────────────────────────────────────────────────────

const lockRank = (k: Snapshot['kind']) => (k === 'official' ? 2 : k === 'late' ? 1 : 0)

/** The saved forecast that stands for one variety and target week (see the header), and why there is none. */
export function chooseForecast(snapshots: Snapshot[], targetYw: number, phase: Phase): { forecast: Snapshot | null; missing: ForecastMissing | null } {
  const forWeek = snapshots.filter((s) => s.targetYw === targetYw)
  const starts = weekStartsAt(targetYw)
  const inTime = phase === 'future' ? forWeek : forWeek.filter((s) => Date.parse(s.savedAt) < starts)
  const usable = inTime.filter((s) => s.available)
  let best: Snapshot | null = null
  for (const s of usable) {
    if (
      !best ||
      s.originYw > best.originYw ||
      (s.originYw === best.originYw && (lockRank(s.kind) > lockRank(best.kind) || (lockRank(s.kind) === lockRank(best.kind) && s.savedAt > best.savedAt)))
    )
      best = s
  }
  if (best) return { forecast: best, missing: best.kg === null ? 'afw_needed' : null }
  if (forWeek.some((s) => s.available)) return { forecast: null, missing: 'saved_after_start' }
  if (forWeek.length) return { forecast: null, missing: 'not_available' }
  return { forecast: null, missing: 'no_forecast' }
}

// ── Cells ────────────────────────────────────────────────────────────────────

export function varietyWeek(crop: HistoryCrop, yw: number, phase: Phase, snapshots: Snapshot[], actuals: Actual[]): VarietyWeek {
  const { forecast, missing } = chooseForecast(snapshots.filter((s) => s.cropId === crop.id), yw, phase)
  const actual = actuals.find((a) => a.cropId === crop.id && a.yw === yw)
  const actualKg = actual?.kg ?? null
  const actualMissing: ActualMissing | null = phase === 'future' ? 'future' : actualKg !== null ? null : phase === 'current' ? 'in_progress' : 'not_entered'
  return {
    crop,
    forecast,
    forecastMissing: missing,
    actualKg: phase === 'future' ? null : actualKg,
    actualMissing,
    matched: phase === 'completed' && forecast?.kg != null && actualKg !== null,
  }
}

export const errorPct = (projected: number, actual: number) => (projected > 0 ? ((projected - actual) / projected) * 100 : null)

export function cellOf(parts: VarietyWeek[]): Cell {
  const withP = parts.filter((p) => p.forecast?.kg != null)
  const withA = parts.filter((p) => p.actualKg !== null)
  const matched = parts.filter((p) => p.matched)
  const mp = matched.reduce((a, p) => a + p.forecast!.kg!, 0)
  const ma = matched.reduce((a, p) => a + p.actualKg!, 0)
  return {
    expected: parts.length,
    projected: withP.length ? withP.reduce((a, p) => a + p.forecast!.kg!, 0) : null,
    projectedComplete: withP.length === parts.length,
    actual: withA.length ? withA.reduce((a, p) => a + p.actualKg!, 0) : null,
    actualComplete: withA.length === parts.length,
    matchedProjected: mp,
    matchedActual: ma,
    matchedCount: matched.length,
    errorPct: matched.length ? errorPct(mp, ma) : null,
    kinds: new Set(parts.flatMap((p) => (p.forecast ? [p.forecast.kind] : []))),
    parts,
  }
}

/** Accuracy over the completed weeks of the table: the matched variety-weeks only. */
export function accuracyOf(rows: HistoryRow[], pick: (r: HistoryRow) => Cell): Accuracy {
  const done = rows.filter((r) => r.phase === 'completed').map(pick)
  const parts = done.flatMap((c) => c.parts)
  const projected = done.reduce((a, c) => a + c.matchedProjected, 0)
  const actual = done.reduce((a, c) => a + c.matchedActual, 0)
  const matched = parts.filter((p) => p.matched).length
  return {
    projected,
    actual,
    errorPct: matched ? errorPct(projected, actual) : null,
    matched,
    expected: parts.length,
    excluded: { forecast: parts.filter((p) => p.forecast?.kg == null).length, actual: parts.filter((p) => p.forecast?.kg != null && p.actualKg === null).length },
    weeks: done.filter((c) => c.matchedCount > 0).length,
  }
}

// ── The page ─────────────────────────────────────────────────────────────────

export type Group = { color: string; crops: HistoryCrop[] }
export const COLOUR_ORDER = ['red', 'orange', 'yellow', 'green', 'other']

export function colourGroups(crops: HistoryCrop[]): Group[] {
  const by = new Map<string, HistoryCrop[]>()
  for (const c of crops) by.set(c.color, [...(by.get(c.color) ?? []), c])
  const rank = (c: string) => (COLOUR_ORDER.includes(c) ? COLOUR_ORDER.indexOf(c) : COLOUR_ORDER.length)
  return [...by.entries()]
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
    .map(([color, list]) => ({ color, crops: [...list].sort((a, b) => a.name.localeCompare(b.name)) }))
}

/**
 * The weeks shown for a year: from the earliest week with a saved projection
 * or an actual kg to the latest of the current week and the furthest future
 * week with an available forecast (at most HORIZON_WEEKS ahead), newest first.
 */
export function historyWeeks(year: number, currentYw: number, snapshots: Snapshot[], actuals: Actual[]): number[] {
  const inYear = (yw: number) => Math.floor(yw / 100) === year
  const cur = indexOfYw(currentYw)
  const past = [
    ...snapshots.filter((s) => s.available && inYear(s.targetYw) && indexOfYw(s.targetYw) <= cur).map((s) => s.targetYw),
    ...actuals.filter((a) => a.kg !== null && inYear(a.yw)).map((a) => a.yw),
  ].map(indexOfYw)
  const future = snapshots
    .filter((s) => s.available && inYear(s.targetYw) && indexOfYw(s.targetYw) > cur && indexOfYw(s.targetYw) <= cur + HORIZON_WEEKS)
    .map((s) => indexOfYw(s.targetYw))
  if (!past.length && !future.length) return []
  const first = Math.min(...past, ...future)
  const last = Math.max(...future, ...(inYear(currentYw) && first <= cur ? [cur] : []), ...past)
  const out: number[] = []
  for (let i = last; i >= first; i--) if (inYear(ywOf(i))) out.push(ywOf(i))
  return out
}

/** The quick views: the whole season (default), or the coming week(s). */
export type RangeView = 'year' | 'next' | 'next5'

/** The weeks of a view, newest first. The coming weeks are listed even without a forecast (shown as missing). */
export function viewWeeks(view: RangeView, year: number, currentYw: number, snapshots: Snapshot[], actuals: Actual[]): number[] {
  if (view === 'year') return historyWeeks(year, currentYw, snapshots, actuals)
  const cur = indexOfYw(currentYw)
  const n = view === 'next' ? 1 : 5
  return Array.from({ length: n }, (_, i) => ywOf(cur + n - i))
}

/** Projected kg over a view's weeks: what a card shows when there is nothing to compare yet. */
export type Projection = { kg: number | null; withForecast: number; expected: number; weeks: number }

export function projectionOf(rows: HistoryRow[], pick: (r: HistoryRow) => Cell): Projection {
  const cells = rows.map(pick)
  const parts = cells.flatMap((c) => c.parts)
  const withKg = parts.filter((p) => p.forecast?.kg != null)
  return { kg: withKg.length ? withKg.reduce((a, p) => a + p.forecast!.kg!, 0) : null, withForecast: withKg.length, expected: parts.length, weeks: rows.length }
}

export type Summary = { accuracy: Accuracy; projection: Projection }

export type ProductionHistory = {
  view: RangeView
  groups: Group[]
  rows: HistoryRow[]
  summary: { byGroup: Map<string, Summary>; all: Summary }
}

export function productionHistory(
  crops: HistoryCrop[],
  snapshots: Snapshot[],
  actuals: Actual[],
  year: number,
  currentYw: number,
  view: RangeView = 'year',
): ProductionHistory {
  const groups = colourGroups(crops)
  const rows: HistoryRow[] = viewWeeks(view, year, currentYw, snapshots, actuals).map((yw) => {
    const phase = phaseOf(yw, currentYw)
    const parts = new Map(crops.filter((c) => inSeason(c, yw)).map((c) => [c.id, varietyWeek(c, yw, phase, snapshots, actuals)]))
    const pick = (list: HistoryCrop[]) => cellOf(list.flatMap((c) => (parts.has(c.id) ? [parts.get(c.id)!] : [])))
    return { yw, phase, byGroup: new Map(groups.map((g) => [g.color, pick(g.crops)])), all: pick(crops) }
  })
  const summary = (pick: (r: HistoryRow) => Cell): Summary => ({ accuracy: accuracyOf(rows, pick), projection: projectionOf(rows, pick) })
  return {
    view,
    groups,
    rows,
    summary: { byGroup: new Map(groups.map((g) => [g.color, summary((r) => r.byGroup.get(g.color)!)])), all: summary((r) => r.all) },
  }
}

/** The newest entry per variety and week (null kg = the week was cleared). */
export function latestActuals(entries: { crop_id: string; year: number; week: number; actual_kg: number | string | null; entered_at: string; id: number }[]): Actual[] {
  const by = new Map<string, (typeof entries)[number]>()
  for (const e of entries) {
    const k = `${e.crop_id}:${e.year}:${e.week}`
    const cur = by.get(k)
    if (!cur || e.entered_at > cur.entered_at || (e.entered_at === cur.entered_at && e.id > cur.id)) by.set(k, e)
  }
  return [...by.values()].map((e) => ({ cropId: e.crop_id, yw: e.year * 100 + e.week, kg: e.actual_kg === null ? null : Number(e.actual_kg), enteredAt: e.entered_at }))
}

/** "+12.4%" / "−8.1%" (true minus sign). */
export const formatError = (pct: number | null) => (pct === null ? '—' : `${pct > 0 ? '+' : pct < 0 ? '−' : ''}${Math.abs(pct).toFixed(1)}%`)
export const errorWord = (pct: number | null) => (pct === null ? '' : pct > 0 ? 'overestimated' : pct < 0 ? 'underestimated' : 'exact')
