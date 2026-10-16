// Rebuilds each pepper's weekly history from the raw records stored by the
// cutoff. Nothing here changes a record; it decides what each record means.
//
// Cleaning rules (per node, in week order; the latest record of a week wins):
//   * an Aborted/Pruned record followed later by any live record was a
//     mis-tap and is ignored (as in weekly_fruit_loss());
//   * a record of an earlier stage than one already recorded (Flower <
//     SetFruit < MatureGreen < BreakerFruit < Harvested) is ignored;
//   * after Harvested or a confirmed loss nothing changes. Aborted (the plant
//     dropped it) and Pruned (removed by the crew) stay distinct.
//
// Visits: a stem was visited in a week when it has any record, a growth
// reading, a new node or an explicit "stem checked" (the rules of
// crop_stem_weeks()). A week a stem wasn't visited is unobserved, never a
// zero. A flag confirmed as a recording error (or a rule the caller chose to
// treat as confirmed) makes its weeks / stem-weeks unobserved and its nodes
// unusable for training; its records stay as they are.

import { basisAt } from './basis'
import type { EngineFlag, EngineInput, NodeStatus } from './types'
import { greenhouseWeekIndex, weekIndex } from './weeks'

/** F flower, S set fruit, M mature green, B breaker, H harvested, A aborted, P pruned. */
export type State = 'F' | 'S' | 'M' | 'B' | 'H' | 'A' | 'P'

/** Aborted or pruned: the fruit is gone without being harvested. */
export const isLoss = (s: State | null) => s === 'A' || s === 'P'
export type FruitStage = 'S' | 'M' | 'B'

const STATE: Record<NodeStatus, State> = {
  Flower: 'F',
  SetFruit: 'S',
  MatureGreen: 'M',
  BreakerFruit: 'B',
  Harvested: 'H',
  Aborted: 'A',
  Pruned: 'P',
}
const RANK: Record<State, number> = { F: 0, S: 1, M: 2, B: 3, H: 4, A: -1, P: -1 }

export type NodeHistory = {
  nodeId: string
  stemId: string
  isSideShoot: boolean
  /** Kept records: week index → state, in week order. */
  records: [number, State][]
  /**
   * Every week's latest record as recorded (before cleaning): repeats kept, so
   * a Breaker recorded again the next Friday shows as Breaker in both weeks.
   */
  weekStates: Map<number, State>
  /** First week the node was a fruit (S, M or B), or null. */
  fruitIndex: number | null
  /** First week of each fruit stage. */
  stageEntry: Partial<Record<FruitStage, number>>
  /** First week recorded Harvested, or null. */
  harvestIndex: number | null
  /** Excluded from training (a confirmed node-level recording error). */
  excluded: boolean
}

export type CropHistory = {
  originIndex: number
  nodes: NodeHistory[]
  /** Stem → weeks with visit evidence that are trusted (confirmed errors removed). */
  observedWeeks: Map<string, Set<number>>
  /**
   * Stem → weeks whose records are verified: the stem was explicitly checked
   * and the week's sampling was marked complete. Every other observed week is
   * legacy (only status changes recorded, e.g. imported history).
   */
  verifiedWeeks: Map<string, Set<number>>
  /** Active stems with visit evidence in or before the origin week. */
  sampleStemIds: string[]
  excludedStemWeeks: number
  /**
   * Whether a week's records describe the whole fruit lifecycle (basis
   * 'lifecycle', the default without settings). In Breakers-only weeks only
   * Breakers are recorded: SetFruit and MatureGreen records aren't updated,
   * so those weeks never teach stage transitions or new-set rates.
   */
  isLifecycleWeek: (index: number) => boolean
}

const isAtOrBefore = (iso: string, cutoffMs: number) => Date.parse(iso) <= cutoffMs


/** Flags that count as confirmed recording errors for this run. */
export function confirmedErrors(flags: EngineFlag[], assumeConfirmed: string[]): EngineFlag[] {
  return flags.filter((f) => f.reviewDecision === 'recording_error' || (f.reviewDecision === null && assumeConfirmed.includes(f.ruleId)))
}

export function buildHistory(input: EngineInput, originIndex: number, cutoff: string, assumeConfirmed: string[] = [], observedCutoff?: string): CropHistory {
  const cutoffMs = Date.parse(cutoff)
  // A record counts when it was observed by the observed cutoff and stored by the cutoff.
  const observedMs = observedCutoff ? Math.min(Date.parse(observedCutoff), cutoffMs) : cutoffMs
  const known = (observedAt: string, recordedAt: string) => Date.parse(observedAt) <= observedMs && Date.parse(recordedAt) <= cutoffMs
  const activeStems = new Set(input.stems.filter((s) => s.isActive).map((s) => s.id))
  const nodes = input.nodes.filter((n) => n.isActive && activeStems.has(n.stemId))
  const nodeById = new Map(nodes.map((n) => [n.id, n]))

  // Latest record per node and week, stored by the cutoff, up to the origin week.
  const latest = new Map<string, { index: number; status: NodeStatus; observedAt: string; recordedAt: string; id: string }>()
  for (const o of input.observations) {
    if (!nodeById.has(o.nodeId) || !known(o.observedAt, o.recordedAt)) continue
    const index = weekIndex(o.year, o.week)
    if (index > originIndex) continue
    const key = `${o.nodeId}:${index}`
    const current = latest.get(key)
    const newer =
      !current ||
      o.observedAt > current.observedAt ||
      (o.observedAt === current.observedAt && (o.recordedAt > current.recordedAt || (o.recordedAt === current.recordedAt && o.id > current.id)))
    if (newer) latest.set(key, { index, status: o.status, observedAt: o.observedAt, recordedAt: o.recordedAt, id: o.id })
  }

  // Visit evidence.
  const visited = new Map<string, Set<number>>()
  const addVisit = (stemId: string, index: number) => {
    if (!activeStems.has(stemId) || index > originIndex) return
    let set = visited.get(stemId)
    if (!set) visited.set(stemId, (set = new Set()))
    set.add(index)
  }
  const byNode = new Map<string, [number, NodeStatus][]>()
  for (const [key, r] of latest) {
    const nodeId = key.slice(0, key.lastIndexOf(':'))
    addVisit(nodeById.get(nodeId)!.stemId, r.index)
    let list = byNode.get(nodeId)
    if (!list) byNode.set(nodeId, (list = []))
    list.push([r.index, r.status])
  }
  for (const g of input.growth) if (isAtOrBefore(g.observedAt, observedMs)) addVisit(g.stemId, weekIndex(g.year, g.week))
  for (const n of nodes) if (isAtOrBefore(n.createdAt, observedMs)) addVisit(n.stemId, greenhouseWeekIndex(new Date(n.createdAt)))
  const checks = new Map<string, { checked: boolean; observedAt: string }>()
  for (const v of input.stemVisits) {
    if (!known(v.observedAt, v.recordedAt)) continue
    const key = `${v.stemId}:${weekIndex(v.year, v.week)}`
    const current = checks.get(key)
    if (!current || v.observedAt >= current.observedAt) checks.set(key, { checked: v.checked, observedAt: v.observedAt })
  }
  for (const [key, c] of checks) if (c.checked) addVisit(key.slice(0, key.lastIndexOf(':')), Number(key.slice(key.lastIndexOf(':') + 1)))

  const sampleStemIds = [...visited.keys()].sort()

  // Verified weeks: explicitly checked stems in weeks whose sampling was (last) marked complete.
  const completion = new Map<number, { event: string; observedAt: string }>()
  for (const e of input.samplingEvents ?? []) {
    if (!known(e.observedAt, e.recordedAt)) continue
    const index = weekIndex(e.year, e.week)
    const current = completion.get(index)
    if (!current || e.observedAt >= current.observedAt) completion.set(index, { event: e.event, observedAt: e.observedAt })
  }
  const verifiedWeeks = new Map<string, Set<number>>()
  for (const [key, c] of checks) {
    const index = Number(key.slice(key.lastIndexOf(':') + 1))
    if (!c.checked || index > originIndex || completion.get(index)?.event !== 'completed') continue
    const stemId = key.slice(0, key.lastIndexOf(':'))
    if (!activeStems.has(stemId)) continue
    let set = verifiedWeeks.get(stemId)
    if (!set) verifiedWeeks.set(stemId, (set = new Set()))
    set.add(index)
  }

  // Confirmed recording errors → unobserved weeks / stem-weeks, excluded nodes.
  const errors = confirmedErrors(input.flags, assumeConfirmed)
  const observedWeeks = new Map<string, Set<number>>()
  for (const [stemId, weeks] of visited) observedWeeks.set(stemId, new Set(weeks))
  let excludedStemWeeks = 0
  const excludedNodes = new Set<string>()
  for (const f of errors) {
    const index = weekIndex(Math.floor(f.yw / 100), f.yw % 100)
    if (f.scope === 'node' && f.nodeId) excludedNodes.add(f.nodeId)
    const stems = f.scope === 'week' ? [...observedWeeks.keys()] : f.scope === 'stem_week' && f.stemId ? [f.stemId] : []
    for (const stemId of stems) {
      if (observedWeeks.get(stemId)?.delete(index)) excludedStemWeeks++
      verifiedWeeks.get(stemId)?.delete(index)
    }
  }

  const histories: NodeHistory[] = []
  for (const [nodeId, raw] of byNode) {
    const node = nodeById.get(nodeId)!
    raw.sort((a, b) => a[0] - b[0])
    const records = cleanRecords(raw)
    if (records.length === 0) continue
    const stageEntry: Partial<Record<FruitStage, number>> = {}
    let fruitIndex: number | null = null
    let harvestIndex: number | null = null
    for (const [index, state] of records) {
      if (state === 'S' || state === 'M' || state === 'B') {
        stageEntry[state] ??= index
        fruitIndex ??= index
      }
      if (state === 'H') harvestIndex ??= index
    }
    histories.push({
      nodeId,
      stemId: node.stemId,
      isSideShoot: node.isSideShoot,
      records,
      weekStates: new Map(raw.map(([index, status]) => [index, STATE[status]])),
      fruitIndex,
      stageEntry,
      harvestIndex,
      excluded: excludedNodes.has(nodeId),
    })
  }

  const lifecycle = new Map<number, boolean>()
  const isLifecycleWeek = (index: number) => {
    let v = lifecycle.get(index)
    if (v === undefined) lifecycle.set(index, (v = basisAt(input.basisSettings, index, cutoffMs).basis === 'lifecycle'))
    return v
  }

  return { originIndex, nodes: histories, observedWeeks, verifiedWeeks, sampleStemIds, excludedStemWeeks, isLifecycleWeek }
}

/** Applies the cleaning rules to one node's weekly records (sorted by week). */
export function cleanRecords(raw: [number, NodeStatus][]): [number, State][] {
  const states = raw.map(([index, status]) => [index, STATE[status]] as [number, State])
  // A loss followed by any live record was a mis-tap.
  const lastLive = states.reduce((max, [index, s]) => (!isLoss(s) ? Math.max(max, index) : max), -Infinity)
  const kept: [number, State][] = []
  let rank = -Infinity
  for (const [index, s] of states) {
    if (isLoss(s)) {
      if (index < lastLive) continue
      kept.push([index, s])
      break
    }
    if (RANK[s] < rank) continue // went backwards: ignore
    if (RANK[s] === rank) continue // repeat: nothing new
    rank = RANK[s]
    kept.push([index, s])
    if (s === 'H') break
  }
  return kept
}

/** A node's state at the end of a week: its latest kept record in or before it. */
export function stateAt(h: NodeHistory, index: number): State | null {
  let state: State | null = null
  for (const [i, s] of h.records) {
    if (i > index) break
    state = s
  }
  return state
}

/** The week the node entered the state it has at `index`. */
export function stateEntryAt(h: NodeHistory, index: number): number | null {
  let entry: number | null = null
  for (const [i] of h.records) {
    if (i > index) break
    entry = i
  }
  return entry
}
