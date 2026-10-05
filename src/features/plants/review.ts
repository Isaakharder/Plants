import { greenhouseIsoWeek } from '../collector/greenhouseWeek'
import type { NodeObservation, NodeStatus, PlantNode } from '../collector/types'
import { isoWeekIndex } from './twin'

// The Plants page's read-only review panel: what it shows about each record of
// a flagged problem, the shared weekly timeline and a plain-language diagnosis.
// Nothing here changes data; structural fixes belong in the mobile collector.

export type Observation = Pick<NodeObservation, 'id' | 'plant_node_id' | 'year' | 'week_number' | 'status' | 'observed_at' | 'recorded_at'>

export const shortId = (id: string) => id.slice(0, 8)

export const nodeName = (n: Pick<PlantNode, 'is_side_shoot' | 'node_label' | 'node_number'>) =>
  n.is_side_shoot ? `Shoot ${n.node_label ?? `${n.node_number}+?`}` : `Node ${n.node_number}`

/** k in "N+k", or null. */
export const shootIndex = (label: string | null) => {
  const k = label?.match(/^\d+\+(\d+)$/)?.[1]
  return k ? Number(k) : null
}

const weekKey = (year: number, week: number) => `${year}-W${String(week).padStart(2, '0')}`
const chronological = (a: Observation, b: Observation) =>
  a.year - b.year || a.week_number - b.week_number || a.observed_at.localeCompare(b.observed_at) || a.recorded_at.localeCompare(b.recorded_at)

export type RecordChild = { node: PlantNode; observationCount: number; latest: Observation | null }

export type RecordSummary = {
  node: PlantNode
  createdWeek: { year: number; week: number }
  observations: Observation[]
  first: Observation | null
  latest: Observation | null
  children: RecordChild[]
}

/** Everything the panel shows about one record. */
export function summarizeRecord(node: PlantNode, rowNodes: PlantNode[], observations: Observation[]): RecordSummary {
  const own = observations.filter((o) => o.plant_node_id === node.id).sort(chronological)
  const children = rowNodes
    .filter((c) => c.parent_node_id === node.id)
    .sort((a, b) => (shootIndex(a.node_label) ?? 99) - (shootIndex(b.node_label) ?? 99) || a.created_at.localeCompare(b.created_at))
    .map((c) => {
      const obs = observations.filter((o) => o.plant_node_id === c.id).sort(chronological)
      return { node: c, observationCount: obs.length, latest: obs.at(-1) ?? null }
    })
  const created = greenhouseIsoWeek(new Date(node.created_at))
  return { node, createdWeek: created, observations: own, first: own[0] ?? null, latest: own.at(-1) ?? null, children }
}

export type Timeline = {
  weeks: { year: number; week: number; key: string }[]
  /** Per record id: the week's status (latest observation that week). */
  cells: Map<string, Map<string, NodeStatus>>
  /** Weeks in which two or more of the records were updated. */
  sharedWeeks: Set<string>
}

/** One shared week axis for comparing the records. */
export function buildTimeline(records: RecordSummary[]): Timeline {
  const cells = new Map<string, Map<string, NodeStatus>>()
  const counts = new Map<string, number>()
  let min = Infinity
  let max = -Infinity
  for (const r of records) {
    const byWeek = new Map<string, NodeStatus>()
    for (const o of r.observations) {
      byWeek.set(weekKey(o.year, o.week_number), o.status)
      const i = isoWeekIndex(o.year, o.week_number)
      min = Math.min(min, i)
      max = Math.max(max, i)
    }
    for (const k of byWeek.keys()) counts.set(k, (counts.get(k) ?? 0) + 1)
    cells.set(r.node.id, byWeek)
  }
  const weeks: Timeline['weeks'] = []
  if (min <= max) {
    // Walk ISO weeks from the first to the last observed week.
    let { year, week } = weekAt(min)
    for (let i = min; i <= max; i++) {
      weeks.push({ year, week, key: weekKey(year, week) })
      ;({ year, week } = weekAt(i + 1))
    }
  }
  return { weeks, cells, sharedWeeks: new Set([...counts].filter(([, n]) => n > 1).map(([k]) => k)) }
}

/** The ISO week whose Monday index (see isoWeekIndex) is i. */
function weekAt(i: number): { year: number; week: number } {
  // isoWeekIndex(y, w) = round(Monday's day number ÷ 7); Mondays fall on day 7i − 3.
  const monday = new Date((7 * i - 3) * 86400000)
  const thursday = new Date(monday.getTime() + 3 * 86400000)
  const year = thursday.getUTCFullYear()
  const jan4 = new Date(Date.UTC(year, 0, 4))
  const week1Monday = jan4.getTime() - ((jan4.getUTCDay() + 6) % 7) * 86400000
  return { year, week: Math.round((monday.getTime() - week1Monday) / (7 * 86400000)) + 1 }
}

/**
 * Main-stem numbers missing near a duplicated number, closest first: the
 * likeliest correct numbers for the extra records. Never chosen automatically.
 */
export function nearbyMissingNumbers(stemNodes: PlantNode[], number: number, recordCount: number): number[] {
  const present = new Set(stemNodes.filter((n) => n.is_active && !n.is_side_shoot).map((n) => n.node_number))
  // Above the stem's highest node nothing is "missing" yet.
  const top = Math.max(0, ...present)
  const out: number[] = []
  for (let n = Math.max(1, number - 3); n <= Math.min(top, number + recordCount + 2); n++) if (!present.has(n)) out.push(n)
  return out.sort((a, b) => Math.abs(a - number) - Math.abs(b - number) || a - b)
}

/** Main-stem numbers around a duplicated number and how many active records each has (0 = missing). */
export function neighbourhood(stemNodes: PlantNode[], number: number, recordCount: number): { number: number; records: number }[] {
  const main = stemNodes.filter((n) => n.is_active && !n.is_side_shoot)
  const top = Math.max(number, ...main.map((n) => n.node_number))
  const out: { number: number; records: number }[] = []
  for (let n = Math.max(1, number - 3); n <= Math.min(top, number + recordCount + 2); n++) {
    out.push({ number: n, records: main.filter((x) => x.node_number === n).length })
  }
  return out
}

const list = (items: (string | number)[]) =>
  items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`

/** Plain-language reading of a group of records the page flagged (or one record). */
export function diagnose(records: RecordSummary[], stemNodes: PlantNode[], timeline: Timeline): string[] {
  const active = records.filter((r) => r.node.is_active)
  if (records.length < 2) return []
  const first = records[0].node
  const lines: string[] = []
  if (first.is_side_shoot) {
    lines.push(`${active.length} side-shoot records are labelled ${first.node_label} on node ${first.node_number}.`)
  } else {
    lines.push(`${active.length} records are labelled Node ${first.node_number}.`)
    const missing = nearbyMissingNumbers(stemNodes, first.node_number, active.length).sort((a, b) => a - b)
    lines.push(
      missing.length
        ? `Nearby node number${missing.length > 1 ? 's' : ''} ${list(missing)} ${missing.length > 1 ? 'are' : 'is'} missing.`
        : `No node numbers near ${first.node_number} are missing, so there is no obvious number to move a record to.`,
    )
  }
  const shared = timeline.weeks.filter((w) => timeline.sharedWeeks.has(w.key)).map((w) => `W${w.week}`)
  if (shared.length) {
    lines.push(`These records were updated independently in the same week${shared.length > 1 ? 's' : ''} (${list(shared)}), so they appear to represent different physical ${first.is_side_shoot ? 'shoots' : 'nodes'}.`)
  } else if (active.filter((r) => r.observations.length > 0).length > 1) {
    lines.push('Their observations never fall in the same week, so they could be one physical node recorded twice, or different nodes. Check the plant.')
  }
  for (const r of active) {
    if (r.observations.length === 0) lines.push(`Record ${shortId(r.node.id)} has no observations — possibly an accidental double tap.`)
  }
  return lines
}
