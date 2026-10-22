// Row-based harvests and post-harvest inspections: the rules the grower's
// Harvests page and the collector both apply.
//
// The database is authoritative: record_harvest_event() validates a harvest,
// post_harvest_inspection_stems() and fruit_harvest_links() compute progress
// and links. These functions mirror those rules for instant feedback on the
// page and for the phone, which has to work offline.

import type { HarvestCoverage, HarvestEventInEffect, HarvestLinkStatus, HarvestRange, HarvestSampledRow, InspectionState, NodeStatus } from '../../lib/database.types'

/**
 * The post-harvest workflow is shown only when VITE_POST_HARVEST_INSPECTIONS
 * is "on" (off by default until it has passed a real-phone test). Turning it
 * off hides the Harvests page and inspection mode; nothing recorded is lost,
 * and the database keeps enforcing its rules either way.
 */
export const POST_HARVEST_ENABLED = import.meta.env.VITE_POST_HARVEST_INSPECTIONS === 'on'

/** Fruit still on the plant: what a post-harvest inspection must answer. */
export const ON_PLANT: ReadonlySet<NodeStatus> = new Set(['SetFruit', 'MatureGreen', 'BreakerFruit'])

/** "Row 171", "row171", "R 171" or "171" → 171; null when the name carries no single number (as greenhouse_row_number()). */
export function greenhouseRowNumber(name: string): number | null {
  const m = name.trim().match(/^(?:row|r)?\s*([0-9]{1,5})$/i)
  return m ? Number(m[1]) : null
}

export type RangeDraft = { from: string; to: string; coverage: HarvestCoverage }
export type RowRef = { id: string; row_name: string; crop_id: string }

export type RangeCheck = {
  /** Valid ranges, ready to save (null while any range is invalid). */
  ranges: HarvestRange[] | null
  /** The variety's sampled rows inside the ranges, by row number. */
  sampledRows: HarvestSampledRow[]
  /** What stops saving. */
  problems: string[]
  /** Ranges without a sampled row (allowed: they still belong in the calendar). */
  withoutSampledRows: HarvestRange[]
}

/**
 * Checks row ranges as record_harvest_event() will: whole numbers, from ≤ to,
 * no overlap, every sampled row of the variety numbered, and no range over a
 * sampled row of another variety growing on that date (`growing`).
 */
export function checkRanges(drafts: RangeDraft[], cropId: string, rows: RowRef[], growing: ReadonlyMap<string, string>): RangeCheck {
  const problems: string[] = []
  const ranges: HarvestRange[] = []
  if (drafts.length === 0) problems.push('Add at least one row range.')
  if (drafts.length > 20) problems.push('At most 20 row ranges.')
  for (const d of drafts) {
    const from = d.from.trim() === '' ? NaN : Number(d.from)
    const to = d.to.trim() === '' ? from : Number(d.to)
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to > 99999) {
      problems.push(`“${d.from}${d.to ? `–${d.to}` : ''}” is not a range of whole row numbers.`)
    } else if (from > to) {
      problems.push(`Rows ${from}–${to}: the first row is after the last.`)
    } else {
      ranges.push({ from, to, coverage: d.coverage })
    }
  }
  for (let i = 0; i < ranges.length; i++) {
    for (let j = i + 1; j < ranges.length; j++) {
      const a = ranges[i], b = ranges[j]
      if (a.from <= b.to && b.from <= a.to) problems.push(`${rangeLabel(a)} and ${rangeLabel(b)} overlap.`)
    }
  }
  const own = rows.filter((r) => r.crop_id === cropId)
  const unnumbered = own.filter((r) => greenhouseRowNumber(r.row_name) === null)
  if (unnumbered.length > 0) {
    problems.push(`These sampled rows have no row number, so ranges can’t be matched to them: ${unnumbered.map((r) => r.row_name).join(', ')}. Rename them (e.g. “Row 171”) first.`)
  }
  const inside = (n: number | null) => n !== null && ranges.find((r) => n >= r.from && n <= r.to)
  for (const r of rows) {
    if (r.crop_id === cropId || !growing.has(r.crop_id)) continue
    const n = greenhouseRowNumber(r.row_name)
    if (inside(n)) problems.push(`Row ${n} is a sampled row of ${growing.get(r.crop_id)}, not this variety.`)
  }
  const sampledRows = own
    .map((r) => ({ r, n: greenhouseRowNumber(r.row_name) }))
    .filter((x): x is { r: RowRef; n: number } => x.n !== null && Boolean(inside(x.n)))
    .sort((a, b) => a.n - b.n)
    .map(({ r, n }) => ({ row_id: r.id, row_name: r.row_name, row_number: n, coverage: (inside(n) as HarvestRange).coverage }))
  const withoutSampledRows = ranges.filter((range) => !own.some((r) => { const n = greenhouseRowNumber(r.row_name); return n !== null && n >= range.from && n <= range.to }))
  return { ranges: problems.length === 0 ? ranges : null, sampledRows, problems, withoutSampledRows }
}

/** "Rows 160–180" / "Row 171" (+ " partial"). */
export function rangeLabel(r: HarvestRange, withCoverage = false): string {
  const rows = r.from === r.to ? `Row ${r.from}` : `Rows ${r.from}–${r.to}`
  return withCoverage && r.coverage === 'partial' ? `${rows} (partial)` : rows
}

export const rangesLabel = (ranges: HarvestRange[]) => ranges.map((r) => rangeLabel(r, true)).join(', ')

/** Harvests to inspect: not cancelled, with sampled rows, newest first. */
export function inspectableHarvests(events: HarvestEventInEffect[], cropId: string): HarvestEventInEffect[] {
  return events
    .filter((e) => e.crop_id === cropId && !e.cancelled && e.sampled_rows.length > 0)
    .sort((a, b) => b.harvest_date.localeCompare(a.harvest_date) || b.first_recorded_at.localeCompare(a.first_recorded_at))
}

// ── Inspection of one stem (the phone's view) ───────────────────────────────

export type InspectionAnswer = { node_observation_id: string; harvest_event_id: string; plant_node_id: string; status: NodeStatus; observed_at: string }
export type InspectionCheck = { measurement_stem_id: string; checked: boolean; observed_at: string; harvest_event_id?: string | null; all_fruit_checked?: boolean | null }

export type StemInspection = {
  /** Fruit on the plant not answered yet in this inspection. */
  toConfirm: string[]
  /** Nodes answered in this inspection, with the answer. */
  answered: Map<string, NodeStatus>
  state: InspectionState
  checkedAt: string | null
}

/**
 * One stem's inspection for a harvest, from what the phone has: each node's
 * latest record, the answers of this inspection, and the stem's checks.
 * A node is to confirm when it has no answer in this inspection and its latest
 * record is fruit on the plant (as post_harvest_inspection_stems(), which also
 * checks the answers against the time of the completed check).
 */
export function stemInspection(
  eventId: string,
  nodeIds: string[],
  latest: ReadonlyMap<string, NodeStatus>,
  answers: InspectionAnswer[],
  checks: InspectionCheck[],
): StemInspection {
  const nodes = new Set(nodeIds)
  const latestAnswer = new Map<string, InspectionAnswer>()
  for (const a of answers) {
    if (a.harvest_event_id !== eventId || !nodes.has(a.plant_node_id)) continue
    const cur = latestAnswer.get(a.plant_node_id)
    if (!cur || a.observed_at >= cur.observed_at) latestAnswer.set(a.plant_node_id, a)
  }
  const answered = new Map([...latestAnswer].map(([id, a]) => [id, a.status]))
  const toConfirm = nodeIds.filter((id) => !answered.has(id) && ON_PLANT.has(latest.get(id) as NodeStatus))
  let check: InspectionCheck | null = null
  for (const c of checks) {
    if (c.harvest_event_id !== eventId) continue
    if (!check || c.observed_at >= check.observed_at) check = c
  }
  const state: InspectionState = !check
    ? answered.size > 0 ? 'in_progress' : 'not_started'
    : !check.checked ? 'retracted'
    : check.all_fruit_checked && toConfirm.length === 0 ? 'complete'
    : 'in_progress'
  return { toConfirm, answered, state, checkedAt: state === 'complete' ? check!.observed_at : null }
}

/** Stems whose latest check for the harvest is "✓ All fruit checked" (the server also verifies every fruit was answered). */
export function inspectedStems(visits: InspectionCheck[], eventId: string): Set<string> {
  const latest = new Map<string, InspectionCheck>()
  for (const v of visits) {
    if (v.harvest_event_id !== eventId) continue
    const cur = latest.get(v.measurement_stem_id)
    if (!cur || v.observed_at >= cur.observed_at) latest.set(v.measurement_stem_id, v)
  }
  return new Set([...latest.values()].filter((v) => v.checked && v.all_fruit_checked).map((v) => v.measurement_stem_id))
}


// ── Links ───────────────────────────────────────────────────────────────────

export const LINK_TEXT: Record<HarvestLinkStatus, string> = {
  confirmed: 'Confirmed',
  inferred: 'Inferred',
  rejected: 'Rejected',
  several_possible: 'Several harvests possible',
  later_harvest: 'Another harvest before the check',
  partial_row: 'Row only partly harvested',
  inspection_incomplete: 'Inspection not complete',
  no_earlier_record: 'Not seen on the plant before',
  no_matching_harvest: 'Seen on the plant after this harvest',
  not_from_inspection: 'Recorded outside an inspection',
}

/** A harvest date the research can use as exact: confirmed, or inferred from a complete inspection. */
export const hasHarvestDate = (s: HarvestLinkStatus) => s === 'confirmed' || s === 'inferred'

// ── Greenhouse calendar and the correction window ────────────────────────────
// Harvests are greenhouse calendar dates (America/Toronto); no time of day is
// recorded. A harvest can be entered, corrected or cancelled through 14 days
// after its date, inclusive; the database enforces it (harvest_events_guard).

const TZ = 'America/Toronto'
const DATE = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' })

/** Today's date in the greenhouse ("YYYY-MM-DD"). */
export const greenhouseToday = (now: Date = new Date()) => DATE.format(now)

export const CORRECTION_DAYS = 14

/** "YYYY-MM-DD" + n days. */
export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

/** The last date a harvest of `date` can be entered or changed. */
export const editableUntil = (date: string) => addDays(date, CORRECTION_DAYS)
/** The earliest harvest date that can still be entered or changed today. */
export const earliestEditable = (today: string) => addDays(today, -CORRECTION_DAYS)

const DAY = new Intl.DateTimeFormat('en-US', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })
/** "Mon, Oct 12" for a calendar date (no time zone shift). */
export const dayLabel = (date: string) => DAY.format(new Date(`${date}T12:00:00Z`))

/** "Node 5" / "Shoot 5+1". */
export const nodeName = (n: { is_side_shoot: boolean; node_label: string | null; node_number: number }) => (n.is_side_shoot ? `Shoot ${n.node_label ?? ''}` : `Node ${n.node_number}`)
