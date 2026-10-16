// Weekly sampling progress for the collector: which stems have been confirmed
// "✓ Stem checked" this week, and whether the crop's sampling was marked
// complete. Pure functions over the merged (server + queued) records.
//
// A stem counts as checked only through its own latest check record that
// week; nothing is inferred. Marking sampling complete never marks the
// unchecked stems as checked: they stay "not visited" for that week.

import { previousIsoWeek, type GreenhouseWeek } from './greenhouseWeek'
import type { MobileRowCard, SamplingWeekEvent, StemVisit, WeekObservation } from './types'

const sameWeek = (r: { year: number; week_number: number }, w: GreenhouseWeek) => r.year === w.year && r.week_number === w.week

/** The stems whose latest check record in the week says checked. */
export function checkedStemIds(visits: StemVisit[], week: GreenhouseWeek): Set<string> {
  const latest = new Map<string, StemVisit>()
  for (const v of visits) {
    if (!sameWeek(v, week)) continue
    const current = latest.get(v.measurement_stem_id)
    if (!current || v.observed_at >= current.observed_at) latest.set(v.measurement_stem_id, v)
  }
  return new Set([...latest.values()].filter((v) => v.checked).map((v) => v.measurement_stem_id))
}

/** The crop's latest completion event for the week, if any. */
export function latestSamplingEvent(events: SamplingWeekEvent[], cropId: string, week: GreenhouseWeek): SamplingWeekEvent | null {
  let latest: SamplingWeekEvent | null = null
  for (const e of events) {
    if (e.crop_id !== cropId || !sameWeek(e, week)) continue
    if (!latest || e.observed_at >= latest.observed_at) latest = e
  }
  return latest
}

export type CropWeekProgress = {
  week: GreenhouseWeek
  /** Active stems in the crop's rows. */
  expected: number
  checked: number
  /** Rows with unchecked stems, in display order. */
  uncheckedByRow: { rowId: string; rowName: string; unchecked: number }[]
  /** Per row: checked of total, for the row cards. */
  byRow: Map<string, { checked: number; total: number }>
  complete: boolean
  /** When the week was last marked complete (null unless complete). */
  completedAt: string | null
}

export function cropWeekProgress(
  cropId: string,
  rows: MobileRowCard[],
  visits: StemVisit[],
  events: SamplingWeekEvent[],
  week: GreenhouseWeek,
): CropWeekProgress {
  const checked = checkedStemIds(visits, week)
  const byRow = new Map<string, { checked: number; total: number }>()
  const uncheckedByRow: CropWeekProgress['uncheckedByRow'] = []
  let expected = 0
  let done = 0
  for (const row of rows.filter((r) => r.crop_id === cropId)) {
    const rowChecked = row.stem_ids.filter((id) => checked.has(id)).length
    byRow.set(row.id, { checked: rowChecked, total: row.stem_ids.length })
    expected += row.stem_ids.length
    done += rowChecked
    if (rowChecked < row.stem_ids.length) uncheckedByRow.push({ rowId: row.id, rowName: row.row_name, unchecked: row.stem_ids.length - rowChecked })
  }
  const event = latestSamplingEvent(events, cropId, week)
  return {
    week,
    expected,
    checked: done,
    uncheckedByRow,
    byRow,
    complete: event?.event === 'completed',
    completedAt: event?.event === 'completed' ? event.observed_at : null,
  }
}

/** The note stored with a completion, so the record says what was confirmed. */
export function completionNote(p: Pick<CropWeekProgress, 'checked' | 'expected'>): string {
  const missing = p.expected - p.checked
  return missing > 0
    ? `Completed with ${p.checked} of ${p.expected} stems checked; ${missing} confirmed as not checked this week.`
    : `Completed with all ${p.expected} stems checked.`
}

/**
 * After checking a stem, the next unchecked stem to show: the first after it,
 * wrapping around; null when every stem in the row is checked.
 */
export function nextUncheckedIndex(stemIds: string[], current: number, checked: Set<string>): number | null {
  for (let step = 1; step <= stemIds.length; step++) {
    const i = (current + step) % stemIds.length
    if (!checked.has(stemIds[i])) return i
  }
  return null
}

/**
 * This week's Breakers for the Friday progress line, counted like the
 * forecast: each node once (its latest record this week is Breaker);
 * "still Breaker" when it was Breaker last week too; "new" when its stem was
 * checked (or recorded) last week without it being Breaker; otherwise
 * "first seen" (the stem wasn't walked last week, or isn't known here).
 */
export type BreakerProgress = { total: number; stillBreaker: number; new: number; firstSeen: number }

export function breakerProgress(cropId: string, observations: WeekObservation[], visits: StemVisit[], week: GreenhouseWeek): BreakerProgress {
  const prev = previousIsoWeek(week)
  const latest = (w: GreenhouseWeek) => {
    const byNode = new Map<string, WeekObservation>()
    for (const o of observations) {
      if (o.crop_id !== cropId || !sameWeek(o, w)) continue
      const cur = byNode.get(o.plant_node_id)
      if (!cur || o.observed_at > cur.observed_at || (o.observed_at === cur.observed_at && o.id > cur.id)) byNode.set(o.plant_node_id, o)
    }
    return byNode
  }
  const now = latest(week)
  const before = latest(prev)
  const walkedLastWeek = checkedStemIds(visits, prev)
  for (const o of before.values()) if (o.stem_id) walkedLastWeek.add(o.stem_id)
  const out: BreakerProgress = { total: 0, stillBreaker: 0, new: 0, firstSeen: 0 }
  for (const [nodeId, o] of now) {
    if (o.status !== 'BreakerFruit') continue
    out.total++
    if (before.get(nodeId)?.status === 'BreakerFruit') out.stillBreaker++
    else if (o.stem_id && walkedLastWeek.has(o.stem_id)) out.new++
    else out.firstSeen++
  }
  return out
}
