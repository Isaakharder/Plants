// Plants › digital twin: turns one row's collector data into plant geometry.
//
// Pure and deterministic: the same data always gives the same drawing, so
// stems never move between renders. Input is exactly what the mobile collector
// reads for a row (fetchRowCanvas); nothing here is stored anywhere.
//
// Coordinate system (SVG units, y grows downward), shared by every stem of the
// row so heights compare directly:
//   baseY                    the soil line
//   nodeY(n)                 main-stem node n, NODE_SPACING per node number
//                            (even spacing; a missing number leaves a gap)
//   the stem tip             just above the stem's highest main node

import type { NodeStatus } from '../../lib/database.types'
import type { GreenhouseWeek } from '../collector/greenhouseWeek'
import type { LatestNodeStatus, MeasurementStem, PlantNode, RowCanvasData, StemGrowthMeasurement } from '../collector/types'
import { duplicatesByNode, findDuplicateGroups, statusCategory, type DuplicateInfo, type StatusCategory } from '../collector/attention'

export const NODE_SPACING = 26
export const TOP_MARGIN = 30
export const TIP_EXTRA = 14
export const BASE_MARGIN = 44
export const STEM_WIDTH = 150
export const STEM_X = 62
export const BRACKET_X = 110
export const SHOOT_ANGLE = (35 * Math.PI) / 180
export const SHOOT_FIRST = 24
export const SHOOT_STEP = 18
export const DUPLICATE_SPREAD = 14
/** Side-shoot records sharing a label are spread this far apart, across the branch. */
export const SHOOT_DUPLICATE_SPREAD = 11
/** Vertical room one two-line growth label needs. */
export const GROWTH_LABEL_GAP = 21
export const STALE_AFTER_WEEKS = 5

// ── Status ─────────────────────────────────────────────────────────────────

// Shared with the mobile collector, so both apps classify statuses and
// duplicates the same way.
export { statusCategory, type StatusCategory } from '../collector/attention'

/** The latest status per node: highest ISO year/week, then latest observed_at. */
export function latestStatusByNode(statuses: LatestNodeStatus[]): Map<string, LatestNodeStatus> {
  const latest = new Map<string, LatestNodeStatus>()
  for (const s of statuses) {
    const current = latest.get(s.plant_node_id)
    if (!current || newer(s, current)) latest.set(s.plant_node_id, s)
  }
  return latest
}

function newer(a: LatestNodeStatus, b: LatestNodeStatus): boolean {
  if (a.year !== b.year) return a.year > b.year
  if (a.week_number !== b.week_number) return a.week_number > b.week_number
  return a.observed_at > b.observed_at
}

/** Weeks since the Monday of 1970-W01, so differences work across ISO years. */
export function isoWeekIndex(year: number, week: number): number {
  const jan4 = Date.UTC(year, 0, 4)
  const jan4Weekday = new Date(jan4).getUTCDay() || 7
  const mondayDays = jan4 / 86_400_000 - (jan4Weekday - 1) + (week - 1) * 7
  return Math.round(mondayDays / 7)
}

export function weeksBetween(from: GreenhouseWeek, to: GreenhouseWeek): number {
  return isoWeekIndex(to.year, to.week) - isoWeekIndex(from.year, from.week)
}

/** An on-plant status not updated for more than 5 weeks may no longer be true. */
export function isStale(category: StatusCategory, weeksSinceUpdate: number | null): boolean {
  return category === 'on_plant' && weeksSinceUpdate !== null && weeksSinceUpdate > STALE_AFTER_WEEKS
}

// ── Geometry helpers ───────────────────────────────────────────────────────

export function rowFrame(maxNodeNumber: number): { height: number; baseY: number } {
  const height = TOP_MARGIN + TIP_EXTRA + Math.max(1, maxNodeNumber) * NODE_SPACING + BASE_MARGIN
  return { height, baseY: height - BASE_MARGIN }
}

export const nodeY = (baseY: number, nodeNumber: number) => baseY - nodeNumber * NODE_SPACING

/** Small stable hash of a string → [0, 1). */
function hash01(text: string, salt: number): number {
  let h = 2166136261 ^ salt
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619)
  return ((h >>> 0) % 100_000) / 100_000
}

/**
 * The stem's gentle sway: x offset from STEM_X at height t above the base.
 * Seeded by the stem id, so each stem has its own curve that never changes.
 * Zero at the base, so every plant stands on the same spot.
 */
export function stemCurve(stemId: string): (t: number) => number {
  const amplitude = 3 + hash01(stemId, 1) * 3.5
  const wavelength = 170 + hash01(stemId, 2) * 90
  const phase = hash01(stemId, 3) * Math.PI * 2
  return (t) => STEM_X + amplitude * (Math.sin((t / wavelength) * Math.PI * 2 + phase) - Math.sin(phase))
}

// ── Twin model ─────────────────────────────────────────────────────────────

export type TwinNode = {
  id: string
  /** "12" for a main node, "12+1" for a side shoot. */
  label: string
  nodeNumber: number
  isShoot: boolean
  side: 'left' | 'right' | null
  parentId: string | null
  /** k in "N+k": the shoot node's position along its branch. */
  shootIndex: number | null
  x: number
  y: number
  /** Which way fruit/flowers hang from this node: -1 left, 1 right. */
  hang: -1 | 1
  status: NodeStatus | null
  statusYear: number | null
  statusWeek: number | null
  observedAt: string | null
  category: StatusCategory
  weeksSinceUpdate: number | null
  stale: boolean
  /** Set when several records share this node's number (main stem) or label (side shoot). */
  duplicate: { count: number; index: number } | null
}

/** Several active records claiming the same node: a main-stem number or a shoot label. */
export type TwinProblem = { key: string; kind: 'main' | 'shoot'; label: string; nodeIds: string[] }

export type TwinBranch = { parentId: string; side: 'left' | 'right'; path: string; nodes: TwinNode[] }

export type GrowthBracket = {
  id: string
  cm: number
  year: number
  week: number
  notes: string | null
  /** The stem section the week's head growth covers: previous reading's top node → this one. */
  fromNode: number
  toNode: number
  yTop: number
  yBottom: number
  latest: boolean
  /** Readings sharing the same top node are stacked: 0, 1, … */
  stackIndex: number
  /** Where the label goes: beside the section, pushed apart so labels never overlap. */
  labelY: number
}

export type UnplacedGrowth = { id: string; cm: number; year: number; week: number; notes: string | null }

export type TwinLeaf = { x: number; y: number; side: -1 | 1 }

export type TwinStem = {
  id: string
  name: string
  path: string
  tipY: number
  maxNodeNumber: number
  mainNodes: TwinNode[]
  branches: TwinBranch[]
  shootCount: number
  missingNumbers: number[]
  duplicateNumbers: number[]
  /** Side-shoot labels with more than one record, e.g. "3+1". */
  duplicateShootLabels: string[]
  problems: TwinProblem[]
  growth: GrowthBracket[]
  unplacedGrowth: UnplacedGrowth[]
  leaves: TwinLeaf[]
}

export type TwinRow = { height: number; baseY: number; maxNodeNumber: number; stems: TwinStem[] }

const byStemOrder = (a: MeasurementStem, b: MeasurementStem) =>
  a.sort_order - b.sort_order || a.stem_name.localeCompare(b.stem_name, undefined, { numeric: true })

const shootIndexOf = (node: PlantNode) => {
  const k = node.node_label?.match(/\+(\d+)$/)?.[1]
  return k ? Number(k) : null
}

/** Builds the drawing model for one row, as of the current greenhouse week. */
export function buildTwin(data: RowCanvasData, current: GreenhouseWeek): TwinRow {
  const stems = data.stems.filter((s) => s.is_active).sort(byStemOrder)
  const activeNodes = data.nodes.filter((n) => n.is_active)
  const latest = latestStatusByNode(data.statuses)
  const maxNodeNumber = Math.max(1, ...activeNodes.filter((n) => !n.is_side_shoot).map((n) => n.node_number))
  const { height, baseY } = rowFrame(maxNodeNumber)

  const describe = (node: PlantNode) => {
    const s = latest.get(node.id) ?? null
    const category = statusCategory(s?.status ?? null)
    const weeksSinceUpdate = s ? weeksBetween({ year: s.year, week: s.week_number }, current) : null
    return {
      status: s?.status ?? null,
      statusYear: s?.year ?? null,
      statusWeek: s?.week_number ?? null,
      observedAt: s?.observed_at ?? null,
      category,
      weeksSinceUpdate,
      stale: isStale(category, weeksSinceUpdate),
    }
  }

  return {
    height,
    baseY,
    maxNodeNumber,
    stems: stems.map((stem) => buildStem(stem, activeNodes.filter((n) => n.measurement_stem_id === stem.id), data.growth.filter((g) => g.measurement_stem_id === stem.id), baseY, describe)),
  }
}

function buildStem(
  stem: MeasurementStem,
  nodes: PlantNode[],
  growth: StemGrowthMeasurement[],
  baseY: number,
  describe: (node: PlantNode) => Omit<TwinNode, 'id' | 'label' | 'nodeNumber' | 'isShoot' | 'side' | 'parentId' | 'shootIndex' | 'x' | 'y' | 'hang' | 'duplicate'>,
): TwinStem {
  const curve = stemCurve(stem.id)
  const main = nodes.filter((n) => !n.is_side_shoot)
  const shoots = nodes.filter((n) => n.is_side_shoot)
  const maxNodeNumber = main.length ? Math.max(...main.map((n) => n.node_number)) : 0
  const shootSideByParent = new Map(shoots.map((s) => [s.parent_node_id, s.side]))
  // Which records are duplicates: the same rule the mobile collector uses.
  const duplicates = duplicatesByNode(nodes)
  const flag = (d: DuplicateInfo | undefined) => (d ? { count: d.count, index: d.index } : null)

  // Main nodes; records sharing a number sit side by side at that height.
  const byNumber = new Map<number, PlantNode[]>()
  for (const n of main) byNumber.set(n.node_number, [...(byNumber.get(n.node_number) ?? []), n])
  const mainNodes: TwinNode[] = []
  for (const [number, group] of [...byNumber.entries()].sort((a, b) => a[0] - b[0])) {
    group.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))
    group.forEach((node) => {
      const y = nodeY(baseY, number)
      const dup = duplicates.get(node.id)
      const dx = dup ? (dup.index - (dup.count - 1) / 2) * DUPLICATE_SPREAD : 0
      // Fruit hangs on the side away from the node's side shoot (collector rule: odd → shoot right).
      const shootSide = shootSideByParent.get(node.id) ?? (number % 2 === 1 ? 'right' : 'left')
      mainNodes.push({
        id: node.id,
        label: String(number),
        nodeNumber: number,
        isShoot: false,
        side: null,
        parentId: null,
        shootIndex: null,
        x: curve(baseY - y) + dx,
        y,
        hang: shootSide === 'right' ? -1 : 1,
        duplicate: flag(dup),
        ...describe(node),
      })
    })
  }
  const mainById = new Map(mainNodes.map((n) => [n.id, n]))

  // Side shoots branch from their actual parent node, on their recorded side.
  const shootsByParent = new Map<string, PlantNode[]>()
  for (const s of shoots) {
    const key = s.parent_node_id ?? `orphan:${s.id}`
    shootsByParent.set(key, [...(shootsByParent.get(key) ?? []), s])
  }
  const branches: TwinBranch[] = []
  for (const [parentId, group] of shootsByParent) {
    const parent = mainById.get(parentId)
    const anchorNumber = parent?.nodeNumber ?? group[0].node_number
    const py = parent?.y ?? nodeY(baseY, anchorNumber)
    const px = parent?.x ?? curve(baseY - py)
    const side: 'left' | 'right' = group[0].side ?? (anchorNumber % 2 === 1 ? 'right' : 'left')
    const dir = side === 'left' ? -1 : 1
    const ordered = [...group].sort((a, b) => (shootIndexOf(a) ?? 99) - (shootIndexOf(b) ?? 99) || a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))
    const indexes = ordered.map((node, i) => shootIndexOf(node) ?? i + 1)
    const shootNodes = ordered.map((node, i): TwinNode => {
      const k = indexes[i]
      const d = SHOOT_FIRST + (k - 1) * SHOOT_STEP
      // Records sharing a label sit side by side across the branch, not on top of each other.
      const dup = duplicates.get(node.id)
      const across = dup ? (dup.index - (dup.count - 1) / 2) * SHOOT_DUPLICATE_SPREAD : 0
      return {
        id: node.id,
        label: node.node_label ?? `${anchorNumber}+${k}`,
        nodeNumber: node.node_number,
        isShoot: true,
        side,
        parentId: node.parent_node_id,
        shootIndex: k,
        x: px + dir * d * Math.cos(SHOOT_ANGLE) + across * Math.sin(SHOOT_ANGLE),
        y: py - d * Math.sin(SHOOT_ANGLE) + across * Math.cos(SHOOT_ANGLE),
        hang: dir,
        duplicate: flag(dup),
        ...describe(node),
      }
    })
    const far = Math.max(...shootNodes.map((n) => Math.hypot(n.x - px, n.y - py)))
    const ex = px + dir * far * Math.cos(SHOOT_ANGLE)
    const ey = py - far * Math.sin(SHOOT_ANGLE)
    const cx = px + dir * far * 0.6
    const cy = py - far * 0.12
    branches.push({ parentId, side, path: `M${f(px)} ${f(py)} Q${f(cx)} ${f(cy)} ${f(ex)} ${f(ey)}`, nodes: shootNodes })
  }

  // The stem: base → just above the highest main node, following its sway.
  const tipT = maxNodeNumber * NODE_SPACING + TIP_EXTRA
  const points: string[] = []
  for (let t = 0; t <= tipT; t += 6) points.push(`${f(curve(t))} ${f(baseY - t)}`)
  points.push(`${f(curve(tipT))} ${f(baseY - tipT)}`)
  const path = `M${points.join(' L')}`

  // Decorative leaves on a few internodes, never at a node, alternating sides.
  const leaves: TwinLeaf[] = []
  for (let n = 2; n < maxNodeNumber; n += 3) {
    const t = (n + 0.5) * NODE_SPACING
    leaves.push({ x: curve(t), y: baseY - t, side: (Math.floor(n / 3) % 2 === 0 ? -1 : 1) })
  }

  const numbers = new Set(main.map((n) => n.node_number))
  const groups = findDuplicateGroups(nodes)
  const problems: TwinProblem[] = [
    ...groups.filter((g) => g.kind === 'main').sort((x, y) => Number(x.label) - Number(y.label)),
    ...groups.filter((g) => g.kind === 'shoot'),
  ].map(({ key, kind, label, nodeIds }) => ({ key, kind, label, nodeIds }))
  return {
    id: stem.id,
    name: stem.stem_name,
    path,
    tipY: baseY - tipT,
    maxNodeNumber,
    mainNodes,
    branches,
    shootCount: shoots.length,
    missingNumbers: Array.from({ length: maxNodeNumber }, (_, i) => i + 1).filter((n) => !numbers.has(n)),
    duplicateNumbers: problems.filter((p) => p.kind === 'main').map((p) => Number(p.label)),
    duplicateShootLabels: problems.filter((p) => p.kind === 'shoot').map((p) => p.label),
    problems,
    leaves,
    ...placeGrowth(growth, baseY),
  }
}

/**
 * Growth readings → stem sections. A reading is that week's head growth: the
 * stem from the previous reading's top node up to this reading's top node
 * (0–4 nodes in practice), not one internode. The first placed reading, or one
 * after a reading without a top node, marks just its own top node. Readings
 * without a top node can't be positioned and are returned separately.
 */
export function placeGrowth(readings: StemGrowthMeasurement[], baseY: number): { growth: GrowthBracket[]; unplacedGrowth: UnplacedGrowth[] } {
  const ordered = [...readings].sort((a, b) => a.year - b.year || a.week_number - b.week_number)
  const growth: GrowthBracket[] = []
  const unplacedGrowth: UnplacedGrowth[] = []
  let previousTop: number | null = null
  for (const r of ordered) {
    const base = { id: r.id, cm: Number(r.growth_cm), year: r.year, week: r.week_number, notes: r.notes?.trim() || null }
    if (r.top_node_number == null) {
      unplacedGrowth.push(base)
      previousTop = null
      continue
    }
    const from = previousTop ?? r.top_node_number
    const low = Math.min(from, r.top_node_number)
    const high = Math.max(from, r.top_node_number)
    growth.push({
      ...base,
      fromNode: from,
      toNode: r.top_node_number,
      yTop: nodeY(baseY, high),
      yBottom: nodeY(baseY, low),
      latest: false,
      stackIndex: growth.filter((g) => g.toNode === r.top_node_number).length,
      labelY: 0,
    })
    previousTop = r.top_node_number
  }
  if (growth.length) growth[growth.length - 1].latest = true
  // Labels sit beside their section; going up the stem, each is pushed above
  // the one below it if they would overlap.
  const byHeight = [...growth].sort((a, b) => b.yBottom + b.yTop - (a.yBottom + a.yTop) || a.week - b.week)
  let floor = Number.POSITIVE_INFINITY
  for (const g of byHeight) {
    const wanted = (g.yTop + g.yBottom) / 2
    g.labelY = Math.min(wanted, floor - GROWTH_LABEL_GAP)
    floor = g.labelY
  }
  return { growth, unplacedGrowth }
}

const f = (n: number) => n.toFixed(1)
