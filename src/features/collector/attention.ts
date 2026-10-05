import { useEffect, useState } from 'react'
import type { AttentionRuleKey } from '../../lib/database.types'
import type { LatestNodeStatus, NodeStatus, PlantNode } from './types'

// Which nodes need attention. Shared by the mobile collector (⚠ and clock
// badges on the row canvas) and the Plants digital twin (duplicate warnings),
// so both always agree on what counts as a duplicate. The clock follows the
// organization's status-specific rules (Settings › Mobile attention rules).
//
// Everything is derived in memory from the row data the canvas already has
// (nodes + latest statuses, merged with this device's queued writes), so it
// works offline and costs no extra requests.

// ── Status categories ───────────────────────────────────────────────────────

export type StatusCategory = 'on_plant' | 'resolved' | 'none'

const ON_PLANT: ReadonlySet<NodeStatus> = new Set(['Flower', 'SetFruit', 'MatureGreen', 'BreakerFruit'])

/** On the plant (flower or fruit still there), resolved (harvested / aborted / pruned), or never observed. */
export function statusCategory(status: NodeStatus | null): StatusCategory {
  if (!status) return 'none'
  return ON_PLANT.has(status) ? 'on_plant' : 'resolved'
}

// ── Duplicates ──────────────────────────────────────────────────────────────

/**
 * Several active records claiming the same node on a stem: main-stem nodes with
 * the same number, or side shoots of the same parent with the same label.
 */
export type DuplicateGroup = { key: string; kind: 'main' | 'shoot'; stemId: string; label: string; nodeIds: string[] }

const byCreated = (a: PlantNode, b: PlantNode) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id)

/** Every duplicate among the active nodes, records within a group oldest first. */
export function findDuplicateGroups(nodes: readonly PlantNode[]): DuplicateGroup[] {
  const groups = new Map<string, { kind: 'main' | 'shoot'; stemId: string; label: string; nodes: PlantNode[] }>()
  for (const n of nodes) {
    if (!n.is_active) continue
    // A shoot without a label can't collide with another (the collector always sets one).
    if (n.is_side_shoot && !n.node_label) continue
    const key = n.is_side_shoot ? `shoot:${n.parent_node_id}:${n.node_label}` : `main:${n.measurement_stem_id}:${n.node_number}`
    const g = groups.get(key) ?? { kind: n.is_side_shoot ? ('shoot' as const) : ('main' as const), stemId: n.measurement_stem_id, label: n.is_side_shoot ? n.node_label! : String(n.node_number), nodes: [] }
    g.nodes.push(n)
    groups.set(key, g)
  }
  return [...groups.entries()]
    .filter(([, g]) => g.nodes.length > 1)
    .map(([key, g]) => ({ key, kind: g.kind, stemId: g.stemId, label: g.label, nodeIds: [...g.nodes].sort(byCreated).map((n) => n.id) }))
}

export type DuplicateInfo = { group: DuplicateGroup; count: number; index: number }

/** Node id → its duplicate group and position in it. */
export function duplicatesByNode(nodes: readonly PlantNode[]): Map<string, DuplicateInfo> {
  const out = new Map<string, DuplicateInfo>()
  for (const group of findDuplicateGroups(nodes)) {
    group.nodeIds.forEach((id, index) => out.set(id, { group, count: group.nodeIds.length, index }))
  }
  return out
}

/** "Another node on this stem is also numbered 12." */
export function duplicateExplanation(d: DuplicateInfo): string {
  const others = d.count - 1
  if (d.group.kind === 'shoot') {
    return others === 1 ? `Another side shoot is also labelled ${d.group.label}.` : `${others} other side shoots are also labelled ${d.group.label}.`
  }
  return others === 1 ? `Another node on this stem is also numbered ${d.group.label}.` : `${others} other nodes on this stem are also numbered ${d.group.label}.`
}

// ── Needs an update (mobile clock) ──────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Days a node may go without an update before the clock shows, from the
 * organization's settings (node_attention_rules): one per latest status, plus
 * 'NoStatus' for a node that has never been observed (an attention-rule key,
 * not a node status). A status without a rule never shows the clock:
 * Harvested, Aborted and Pruned are final, nothing is left on the plant to update.
 */
export type AttentionRules = Partial<Record<AttentionRuleKey, number>>

/** The rules Settings offers, in the order shown. */
export const RULE_KEYS = ['NoStatus', 'Flower', 'SetFruit', 'MatureGreen', 'BreakerFruit'] as const satisfies readonly AttentionRuleKey[]

/** Used until a device has downloaded its organization's rules for the first time (same as the database seed). */
export const DEFAULT_ATTENTION_RULES: Readonly<AttentionRules> = { NoStatus: 7, Flower: 7, SetFruit: 14, MatureGreen: 49, BreakerFruit: 14 }

/** The organization's rule rows → rules. Rows are authoritative: no row, no clock. */
export function rulesFromRows(rows: readonly { rule_key: AttentionRuleKey; max_days: number }[]): AttentionRules {
  return Object.fromEntries(rows.map((r) => [r.rule_key, r.max_days]))
}

/**
 * Not the desktop's "possibly stale" (> 5 ISO weeks) warning: that one flags
 * long-forgotten crop records; this one tells the worker which nodes are due
 * for a look.
 */
export type NodeClock =
  | { kind: 'overdue'; ageDays: number; intervalDays: number; status: NodeStatus; year: number; week: number; observedAt: string }
  | { kind: 'never'; ageDays: number; intervalDays: number; createdAt: string }

/**
 * The node's clock at `now`, or null. Exact elapsed time, so DST and ISO
 * week/year boundaries never shift it:
 *   observed → now − latest observed_at ≥ rule[latest status] × 24 h
 *   never observed → now − created_at ≥ rule.NoStatus × 24 h
 * `latest` is the node's latest observation, queued ones included, so the
 * first status recorded switches the node to that status's rule at once.
 */
export function nodeClock(
  node: Pick<PlantNode, 'is_active' | 'created_at'>,
  latest: Pick<LatestNodeStatus, 'status' | 'year' | 'week_number' | 'observed_at'> | undefined,
  now: number,
  rules: AttentionRules,
): NodeClock | null {
  if (!node.is_active) return null
  if (latest) {
    const intervalDays = rules[latest.status]
    if (intervalDays == null) return null
    const age = now - Date.parse(latest.observed_at)
    if (!(age >= intervalDays * DAY_MS)) return null
    return { kind: 'overdue', ageDays: Math.floor(age / DAY_MS), intervalDays, status: latest.status, year: latest.year, week: latest.week_number, observedAt: latest.observed_at }
  }
  const intervalDays = rules.NoStatus
  if (intervalDays == null) return null
  const age = now - Date.parse(node.created_at)
  if (!(age >= intervalDays * DAY_MS)) return null
  return { kind: 'never', ageDays: Math.floor(age / DAY_MS), intervalDays, createdAt: node.created_at }
}

// ── Per-node attention for a row ────────────────────────────────────────────

export type NodeAttention = { duplicate: DuplicateInfo | null; clock: NodeClock | null }

/** Attention for every active node of a row that needs it (absent = nothing to show). */
export function rowAttention(nodes: readonly PlantNode[], statuses: readonly LatestNodeStatus[], now: number, rules: AttentionRules): Map<string, NodeAttention> {
  const latest = new Map(statuses.map((s) => [s.plant_node_id, s]))
  const duplicates = duplicatesByNode(nodes)
  const out = new Map<string, NodeAttention>()
  for (const n of nodes) {
    if (!n.is_active) continue
    const duplicate = duplicates.get(n.id) ?? null
    const clock = nodeClock(n, latest.get(n.id), now, rules)
    if (duplicate || clock) out.set(n.id, { duplicate, clock })
  }
  return out
}

/** Current time for the clock badges, re-read every minute and when the app returns to the foreground. */
export function useNow(intervalMs = 60_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const refresh = () => setNow(Date.now())
    const onVisible = () => {
      if (document.visibilityState === 'visible') refresh()
    }
    const timer = window.setInterval(refresh, intervalMs)
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', refresh)
    window.addEventListener('pageshow', refresh)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', refresh)
      window.removeEventListener('pageshow', refresh)
    }
  }, [intervalMs])
  return now
}
