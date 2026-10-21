import type { WeeklyHarvestableRow, WeeklyPlantDataRow } from '../../lib/database.types'

// Harvestable in Projections › Weekly Plant Data: peppers marked ready to pick
// in a week (collector, harvestable_marks), turned into a same-week projection.
// It belongs to the week of the marks only and is kept apart from Harvested,
// so the two can be compared. Peppers marked and then recorded Harvested the
// same week are already in Picked kg: only the remainder is added to it.

export type HarvestableWeek = {
  week: number
  /** Peppers marked Harvestable (each counted once). */
  marked: number
  /** Of those, recorded Harvested in the same week. */
  harvested: number
  /** Marked and not (yet) recorded Harvested that week. */
  remaining: number
  /** Sampled m² the count is divided by, and the week it comes from (null: no sampled week yet). */
  areaM2: number | null
  areaWeek: number | null
  perM2: number | null
  /** AFW used, and the week it was entered for (null: none entered up to this week). */
  afwG: number | null
  afwWeek: number | null
  /** All marked peppers, in kg for the whole crop area. */
  kg: number | null
  /** The remainder only, in kg. */
  remainingKg: number | null
}

/**
 * Sampled m² for a week's Harvestable count. A midweek count usually comes
 * before that week's walkthrough, so the week's own sampled stems are
 * incomplete until the week is over: the current (in-progress) week, or a
 * week nobody sampled, uses the nearest earlier sampled week instead.
 */
export function harvestableArea(weeks: readonly WeeklyPlantDataRow[], week: number): { areaM2: number; week: number } | null {
  const own = weeks.find((w) => w.iso_week === week)
  if (own && !own.is_provisional && own.is_sampled && own.sampled_m2) return { areaM2: own.sampled_m2, week }
  const earlier = weeks.filter((w) => w.iso_week < week && w.is_sampled && w.sampled_m2).sort((a, b) => b.iso_week - a.iso_week)[0]
  return earlier ? { areaM2: earlier.sampled_m2!, week: earlier.iso_week } : null
}

/** The week's AFW, or the most recent one entered before it. */
export function harvestableAfw(afwOf: (week: number) => number | null, week: number): { afwG: number; week: number } | null {
  for (let w = week; w >= 1; w--) {
    const afw = afwOf(w)
    if (afw !== null) return { afwG: afw, week: w }
  }
  return null
}

export function harvestableWeek(
  row: WeeklyHarvestableRow,
  weeks: readonly WeeklyPlantDataRow[],
  afwOf: (week: number) => number | null,
  cropAreaM2: number,
): HarvestableWeek {
  const area = harvestableArea(weeks, row.iso_week)
  const afw = harvestableAfw(afwOf, row.iso_week)
  const remaining = Math.max(0, row.harvestable - row.harvested_same_week)
  const toKg = (n: number) => (area && afw ? ((n / area.areaM2) * cropAreaM2 * afw.afwG) / 1000 : null)
  return {
    week: row.iso_week,
    marked: row.harvestable,
    harvested: row.harvested_same_week,
    remaining,
    areaM2: area?.areaM2 ?? null,
    areaWeek: area?.week ?? null,
    perM2: area ? row.harvestable / area.areaM2 : null,
    afwG: afw?.afwG ?? null,
    afwWeek: afw?.week ?? null,
    kg: toKg(row.harvestable),
    remainingKg: toKg(remaining),
  }
}

const kgText = (kg: number) => `${Math.round(kg).toLocaleString('en-US')} kg`

/** Hover text for the Harvestable kg cell: the calculation, and the week's projection without counting anyone twice. */
export function harvestableKgTitle(h: HarvestableWeek, cropAreaM2: number, pickedKg: number | null): string {
  if (h.areaM2 === null) return `No sampled week yet to divide W${h.week}'s ${h.marked} Harvestable peppers by.`
  if (h.afwG === null) return `Enter an AFW (W${h.week} or earlier) to convert W${h.week}'s Harvestable peppers to kg.`
  const lines = [
    `W${h.week} Harvestable: ${h.marked} peppers ÷ ${h.areaM2.toFixed(2)} m² sampled${h.areaWeek !== h.week ? ` (W${h.areaWeek})` : ''} × ${Math.round(cropAreaM2).toLocaleString('en-US')} m² × ${h.afwG} g${h.afwWeek !== h.week ? ` (AFW W${h.afwWeek})` : ''} = ${kgText(h.kg ?? 0)}`,
    'Counts for this week only. It doesn’t change Breakers, Harvested or later weeks.',
  ]
  if (h.harvested > 0) {
    lines.push(`${h.harvested} of them already recorded Harvested this week (in Picked kg); ${h.remaining} still to pick ≈ ${kgText(h.remainingKg ?? 0)}.`)
  }
  if (pickedKg !== null) lines.push(`W${h.week} projection: Picked ${kgText(pickedKg)} + still to pick ${kgText(h.remainingKg ?? 0)} = ${kgText(pickedKg + (h.remainingKg ?? 0))}.`)
  return lines.join('\n')
}
