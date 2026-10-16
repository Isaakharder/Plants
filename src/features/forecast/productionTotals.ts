// Projections › Production Totals: the whole greenhouse's projected harvest per
// week, by pepper colour and combined. No forecasting formula of its own: it
// adds up the Harvest Forecast figures already stored (locked forecasts and
// saved preliminary forecasts).
//
// For each variety and target week exactly one forecast is used (never two
// versions or overlapping forecasts added together):
//   1. a locked forecast (Official, or Late) covering that week, the one from
//      the latest sampling week;
//   2. otherwise the saved preliminary forecast from the latest sampling week
//      (its newest version), flagged when its data has changed since.
// Only weeks a forecast supports count (Breakers only: next week).
//
// Cases are converted per variety with that variety's own case weight, then
// added up. Varieties without a forecast, an AFW (kg) or a case weight for a
// week make that week's totals incomplete; they are listed, never counted as
// zero. A variety is expected in a week from its planting date to its
// pullout date.

import type { CropColor } from '../../lib/database.types'

export type TotalsCrop = {
  id: string
  name: string
  color: CropColor | string
  caseWeightKg: number | null
  plantingDate: string
  pulloutDate: string
}

/** One week of a stored forecast, as Production Totals needs it. */
export type SourceWeek = {
  cropId: string
  /** Target week (ISO year·week as yyyyww). */
  targetYw: number
  originYw: number
  status: 'official' | 'late' | 'preliminary'
  available: boolean
  /** Peppers for the whole crop (null when not available). */
  cropFruit: number | null
  /** Null without an AFW. */
  kg: number | null
  /** Stored cases (locked forecasts, case weight at locking); null to convert with the variety's case weight. */
  cases: number | null
  /** Preliminary only: the data changed since it was generated. */
  outdated?: boolean
  /** Newest first among versions of the same preliminary origin week (ISO timestamp). */
  createdAt?: string
}

export type CellSource = { cropId: string; cropName: string; status: SourceWeek['status']; originYw: number; outdated: boolean; kg: number | null; cases: number | null }
export type CellMissing = { cropId: string; cropName: string; reason: 'no_forecast' | 'afw_needed' | 'no_case_weight' }

export type TotalsCell = {
  /** Sum over the varieties that have kg (partial when kgComplete is false). */
  kg: number | null
  cases: number | null
  kgComplete: boolean
  casesComplete: boolean
  /** Varieties expected that week. */
  expected: number
  sources: CellSource[]
  missing: CellMissing[]
  /** 'official': every source locked on time; 'preliminary': any preliminary; 'mixed': locked late and/or official only. */
  status: 'official' | 'preliminary' | 'locked' | 'none'
  anyOutdated: boolean
}

export type ColourGroup = { color: string; crops: TotalsCrop[] }

export const COLOUR_ORDER = ['red', 'orange', 'yellow', 'green', 'other']

/** Colours in use, in the usual order; any other colour value follows, alphabetically. */
export function colourGroups(crops: TotalsCrop[]): ColourGroup[] {
  const by = new Map<string, TotalsCrop[]>()
  for (const c of crops) by.set(c.color, [...(by.get(c.color) ?? []), c])
  const rank = (c: string) => (COLOUR_ORDER.includes(c) ? COLOUR_ORDER.indexOf(c) : COLOUR_ORDER.length)
  return [...by.entries()]
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
    .map(([color, list]) => ({ color, crops: list.sort((a, b) => a.name.localeCompare(b.name)) }))
}

/**
 * The forecast used for one variety and target week: locked over preliminary,
 * then the latest sampling week, then (preliminary) the newest version.
 */
export function chooseSource(candidates: SourceWeek[]): SourceWeek | null {
  const rank = (s: SourceWeek) => (s.status === 'preliminary' ? 0 : 1)
  let best: SourceWeek | null = null
  for (const c of candidates) {
    if (
      !best ||
      rank(c) > rank(best) ||
      (rank(c) === rank(best) && (c.originYw > best.originYw || (c.originYw === best.originYw && (c.createdAt ?? '') > (best.createdAt ?? ''))))
    ) {
      best = c
    }
  }
  return best
}

/** Monday of an ISO week (UTC date), for the season window. */
function mondayOf(yw: number): string {
  const year = Math.floor(yw / 100)
  const week = yw % 100
  const jan4 = Date.UTC(year, 0, 4)
  const day = new Date(jan4).getUTCDay() || 7
  return new Date(jan4 + ((week - 1) * 7 - (day - 1)) * 86_400_000).toISOString().slice(0, 10)
}

export const inSeason = (crop: TotalsCrop, yw: number) => {
  const monday = mondayOf(yw)
  return crop.plantingDate <= monday && monday <= crop.pulloutDate
}

/** One variety's contribution to a week: the chosen forecast, converted to cases with its own case weight. */
export function varietyWeek(crop: TotalsCrop, yw: number, sources: SourceWeek[]): { source: CellSource | null; missing: CellMissing[] } {
  const chosen = chooseSource(sources.filter((s) => s.cropId === crop.id && s.targetYw === yw && s.available))
  if (!chosen) return { source: null, missing: [{ cropId: crop.id, cropName: crop.name, reason: 'no_forecast' }] }
  const kg = chosen.kg
  const cases = kg === null ? null : chosen.cases ?? (crop.caseWeightKg ? kg / crop.caseWeightKg : null)
  const missing: CellMissing[] = []
  if (kg === null) missing.push({ cropId: crop.id, cropName: crop.name, reason: 'afw_needed' })
  else if (cases === null) missing.push({ cropId: crop.id, cropName: crop.name, reason: 'no_case_weight' })
  return {
    source: { cropId: crop.id, cropName: crop.name, status: chosen.status, originYw: chosen.originYw, outdated: Boolean(chosen.outdated), kg, cases },
    missing,
  }
}

/** Adds up a set of varieties for one week. */
export function weekCell(crops: TotalsCrop[], yw: number, sources: SourceWeek[]): TotalsCell {
  const expected = crops.filter((c) => inSeason(c, yw))
  const parts = expected.map((c) => varietyWeek(c, yw, sources))
  const used = parts.map((p) => p.source).filter((s): s is CellSource => s !== null)
  const missing = parts.flatMap((p) => p.missing)
  const withKg = used.filter((s) => s.kg !== null)
  const withCases = used.filter((s) => s.cases !== null)
  // Nothing expected (no variety of this colour in season): nothing missing.
  const kgComplete = withKg.length === expected.length
  return {
    kg: withKg.length ? withKg.reduce((a, s) => a + s.kg!, 0) : null,
    cases: withCases.length ? withCases.reduce((a, s) => a + s.cases!, 0) : null,
    kgComplete,
    casesComplete: kgComplete && withCases.length === expected.length,
    expected: expected.length,
    sources: used,
    missing,
    status: used.length === 0 ? 'none' : used.some((s) => s.status === 'preliminary') ? 'preliminary' : used.every((s) => s.status === 'official') ? 'official' : 'locked',
    anyOutdated: used.some((s) => s.outdated),
  }
}

/** Several cells added up (a colour over several weeks, or the greenhouse): complete only if every cell is. */
export function sumCells(cells: TotalsCell[]): TotalsCell {
  const add = (xs: (number | null)[]) => (xs.some((x) => x !== null) ? xs.reduce<number>((a, x) => a + (x ?? 0), 0) : null)
  const sources = cells.flatMap((c) => c.sources)
  return {
    kg: add(cells.map((c) => c.kg)),
    cases: add(cells.map((c) => c.cases)),
    kgComplete: cells.every((c) => c.kgComplete),
    casesComplete: cells.every((c) => c.casesComplete),
    expected: cells.reduce((a, c) => a + c.expected, 0),
    sources,
    missing: cells.flatMap((c) => c.missing),
    status: sources.length === 0 ? 'none' : cells.some((c) => c.status === 'preliminary') ? 'preliminary' : cells.every((c) => c.status === 'official' || c.status === 'none') ? 'official' : 'locked',
    anyOutdated: cells.some((c) => c.anyOutdated),
  }
}

export type ProductionTotals = {
  colours: ColourGroup[]
  weeks: { yw: number; byColour: Map<string, TotalsCell>; all: TotalsCell }[]
  /** Over the selected weeks. */
  totals: { byColour: Map<string, TotalsCell>; all: TotalsCell }
}

export function productionTotals(crops: TotalsCrop[], sources: SourceWeek[], weeks: number[]): ProductionTotals {
  const colours = colourGroups(crops)
  const rows = weeks.map((yw) => {
    const byColour = new Map(colours.map((g) => [g.color, weekCell(g.crops, yw, sources)]))
    return { yw, byColour, all: weekCell(crops, yw, sources) }
  })
  return {
    colours,
    weeks: rows,
    totals: {
      byColour: new Map(colours.map((g) => [g.color, sumCells(rows.map((r) => r.byColour.get(g.color)!))])),
      all: sumCells(rows.map((r) => r.all)),
    },
  }
}
