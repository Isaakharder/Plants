import { describe, expect, it } from 'vitest'
import type { LatestNodeStatus, MeasurementStem, PlantNode, RowCanvasData, StemGrowthMeasurement } from '../collector/types'
import {
  DUPLICATE_SPREAD,
  GROWTH_LABEL_GAP,
  NODE_SPACING,
  SHOOT_DUPLICATE_SPREAD,
  SHOOT_FIRST,
  SHOOT_STEP,
  buildTwin,
  isStale,
  isoWeekIndex,
  latestStatusByNode,
  nodeY,
  placeGrowth,
  statusCategory,
  stemCurve,
  weeksBetween,
  type TwinStem,
} from './twin'

const NOW = { year: 2026, week: 41 }
const ORG = 'org'
const CROP = 'crop'
const stamp = { created_by: null, created_at: '2026-06-01T00:00:00Z', updated_at: '2026-06-01T00:00:00Z' }

const stem = (id: string, name: string, sort: number): MeasurementStem => ({
  id, organization_id: ORG, crop_id: CROP, measurement_row_id: 'row', stem_name: name, sort_order: sort, is_active: true, ...stamp,
})
const main = (id: string, stemId: string, n: number, createdAt = stamp.created_at): PlantNode => ({
  id, organization_id: ORG, crop_id: CROP, measurement_stem_id: stemId, node_number: n, sort_order: n,
  is_side_shoot: false, parent_node_id: null, node_label: null, side: null, is_active: true, ...stamp, created_at: createdAt,
})
const shoot = (id: string, stemId: string, parent: PlantNode, k: number, side: 'left' | 'right'): PlantNode => ({
  ...main(id, stemId, parent.node_number), is_side_shoot: true, parent_node_id: parent.id, node_label: `${parent.node_number}+${k}`, side,
})
const status = (nodeId: string, s: LatestNodeStatus['status'], week: number, observedAt = `2026-0${Math.min(9, Math.floor(week / 4))}-01T12:00:00Z`, year = 2026): LatestNodeStatus => ({
  id: `${nodeId}-${week}`, plant_node_id: nodeId, year, week_number: week, status: s, observed_at: observedAt,
})
const reading = (id: string, stemId: string, week: number, cm: number, top: number | null, notes: string | null = null): StemGrowthMeasurement => ({
  id, organization_id: ORG, crop_id: CROP, measurement_stem_id: stemId, year: 2026, week_number: week, growth_cm: cm,
  top_node_number: top, notes, observed_at: '2026-06-01T00:00:00Z', ...stamp,
})

// Stem 1: 31 main nodes. Stem 2: 25 main nodes. Stem 10: duplicates (12 ×2) and a gap (13–15 missing).
const s1 = stem('stem-1', 'Stem 1', 1)
const s2 = stem('stem-2', 'Stem 2', 2)
const s10 = stem('stem-10', 'Stem 10', 10)
const s1Nodes = Array.from({ length: 31 }, (_, i) => main(`a${i + 1}`, s1.id, i + 1))
const s2Nodes = Array.from({ length: 25 }, (_, i) => main(`b${i + 1}`, s2.id, i + 1))
const s10Nodes = [
  ...[...Array(12)].map((_, i) => main(`c${i + 1}`, s10.id, i + 1)),
  main('c12-dup', s10.id, 12, '2026-07-01T00:00:00Z'),
  main('c16', s10.id, 16),
]
// Side shoots: node 5 (odd) → right with 5+1 and 5+2; node 6 (even) → left.
const shoot51 = shoot('a5+1', s1.id, s1Nodes[4], 1, 'right')
const shoot52 = shoot('a5+2', s1.id, s1Nodes[4], 2, 'right')
const shoot61 = shoot('a6+1', s1.id, s1Nodes[5], 1, 'left')

const data: RowCanvasData = {
  row: null,
  // Deliberately out of order: stems sort by sort order, "Stem 10" after "Stem 2".
  stems: [s10, s2, s1],
  nodes: [...s1Nodes, ...s2Nodes, ...s10Nodes, shoot51, shoot52, shoot61],
  statuses: [
    status('a31', 'Flower', 40),
    status('a30', 'SetFruit', 34), // 7 weeks ago → stale
    status('a29', 'SetFruit', 36), // 5 weeks ago → not stale
    status('a28', 'MatureGreen', 40),
    status('a27', 'BreakerFruit', 40),
    status('a1', 'Harvested', 30),
    status('a2', 'Aborted', 25),
    status('a5+1', 'Pruned', 30),
    status('a5+2', 'SetFruit', 40),
  ],
  growth: [
    reading('g25', s1.id, 25, 9.5, null, 'started measuring'),
    reading('g29', s1.id, 29, 10, 14),
    reading('g30', s1.id, 30, 7.5, 15),
    reading('g32', s1.id, 32, 7, 19),
    reading('g33', s1.id, 33, 8, 19),
  ],
}
const twin = buildTwin(data, NOW)
const stemById = (id: string): TwinStem => twin.stems.find((s) => s.id === id)!
const nodeById = (s: TwinStem, id: string) => [...s.mainNodes, ...s.branches.flatMap((b) => b.nodes)].find((n) => n.id === id)!

describe('vertical position', () => {
  it('places node n at baseY − n × spacing, the same for every stem', () => {
    expect(nodeById(stemById(s1.id), 'a10').y).toBe(twin.baseY - 10 * NODE_SPACING)
    expect(nodeById(stemById(s2.id), 'b10').y).toBe(nodeById(stemById(s1.id), 'a10').y)
    expect(nodeY(twin.baseY, 1) - nodeY(twin.baseY, 2)).toBe(NODE_SPACING)
  })

  it('makes a stem with more nodes taller (31 vs 25), sharing one base line', () => {
    const tall = stemById(s1.id)
    const short = stemById(s2.id)
    expect(tall.tipY).toBeLessThan(short.tipY)
    expect(short.tipY - tall.tipY).toBe(6 * NODE_SPACING)
    expect(twin.maxNodeNumber).toBe(31)
  })

  it('orders stems by sort order (Stem 1, Stem 2, Stem 10)', () => {
    expect(twin.stems.map((s) => s.name)).toEqual(['Stem 1', 'Stem 2', 'Stem 10'])
  })
})

describe('stem curve', () => {
  it('is deterministic per stem, different between stems, and starts at the same base point', () => {
    expect(buildTwin(data, NOW).stems[0].path).toBe(twin.stems[0].path)
    const a = stemCurve('stem-1')
    const b = stemCurve('stem-2')
    expect(a(0)).toBe(b(0))
    expect([100, 300, 500].map(a)).not.toEqual([100, 300, 500].map(b))
    expect(Math.max(...[0, 50, 100, 200, 400, 800].map((t) => Math.abs(a(t) - a(0))))).toBeLessThan(15)
  })

  it('puts every main node on the stem line', () => {
    const s = stemById(s1.id)
    const curve = stemCurve(s.id)
    for (const n of s.mainNodes) expect(n.x).toBeCloseTo(curve(twin.baseY - n.y), 6)
  })
})

describe('side shoots', () => {
  const s = stemById(s1.id)
  const branch5 = s.branches.find((b) => b.parentId === 'a5')!
  const parent5 = nodeById(s, 'a5')

  it('branch from their actual parent node', () => {
    expect(branch5.path.startsWith(`M${parent5.x.toFixed(1)} ${parent5.y.toFixed(1)}`)).toBe(true)
    for (const n of branch5.nodes) expect(n.y).toBeLessThan(parent5.y) // angled upward
  })

  it('go to their recorded side: right for 5+k, left for 6+1', () => {
    for (const n of branch5.nodes) expect(n.x).toBeGreaterThan(parent5.x)
    const left = nodeById(s, 'a6+1')
    expect(left.x).toBeLessThan(nodeById(s, 'a6').x)
    expect(left.side).toBe('left')
  })

  it('place N+1 and N+2 outward along the same branch', () => {
    const k1 = nodeById(s, 'a5+1')
    const k2 = nodeById(s, 'a5+2')
    expect(Math.hypot(k1.x - parent5.x, k1.y - parent5.y)).toBeCloseTo(SHOOT_FIRST, 6)
    expect(Math.hypot(k2.x - parent5.x, k2.y - parent5.y)).toBeCloseTo(SHOOT_FIRST + SHOOT_STEP, 6)
    // Same direction from the parent: collinear.
    expect((k2.y - parent5.y) / (k2.x - parent5.x)).toBeCloseTo((k1.y - parent5.y) / (k1.x - parent5.x), 6)
    expect([k1.shootIndex, k2.shootIndex]).toEqual([1, 2])
    expect(s.shootCount).toBe(3)
  })

  it('hang main-node fruit away from the side shoot', () => {
    expect(parent5.hang).toBe(-1) // shoot right → fruit left
    expect(nodeById(s, 'a6').hang).toBe(1)
  })
})

describe('duplicate and missing node numbers', () => {
  const s = stemById(s10.id)

  it('puts duplicate records side by side at the same height and flags them', () => {
    const a = nodeById(s, 'c12')
    const b = nodeById(s, 'c12-dup')
    expect(a.y).toBe(b.y)
    expect(b.x - a.x).toBeCloseTo(DUPLICATE_SPREAD, 6)
    expect([a.duplicate, b.duplicate]).toEqual([{ count: 2, index: 0 }, { count: 2, index: 1 }])
    expect(s.duplicateNumbers).toEqual([12])
  })

  it('leaves missing numbers as a vertical gap', () => {
    expect(s.missingNumbers).toEqual([13, 14, 15])
    expect(nodeById(s, 'c12').y - nodeById(s, 'c16').y).toBe(4 * NODE_SPACING)
  })
})

describe('statuses', () => {
  const s = stemById(s1.id)

  it('uses each node’s latest status (year, week, then observed time)', () => {
    const latest = latestStatusByNode([
      status('n', 'Flower', 30, '2026-07-20T12:00:00Z'),
      status('n', 'SetFruit', 31, '2026-07-27T08:00:00Z'),
      { ...status('n', 'Aborted', 31, '2026-07-27T09:00:00Z'), id: 'later-same-week' },
      status('n', 'MatureGreen', 30, '2026-07-21T12:00:00Z'),
    ])
    expect(latest.get('n')?.status).toBe('Aborted')
    expect(latestStatusByNode([status('m', 'Harvested', 1, '2027-01-05T12:00:00Z', 2027), status('m', 'BreakerFruit', 52)]).get('m')?.year).toBe(2027)
  })

  it('classifies current, resolved and never-observed nodes', () => {
    expect(['Flower', 'SetFruit', 'MatureGreen', 'BreakerFruit'].map((x) => statusCategory(x as never))).toEqual(['on_plant', 'on_plant', 'on_plant', 'on_plant'])
    expect(['Harvested', 'Aborted', 'Pruned'].map((x) => statusCategory(x as never))).toEqual(['resolved', 'resolved', 'resolved'])
    expect(statusCategory(null)).toBe('none')
    expect(nodeById(s, 'a10').category).toBe('none')
    expect(nodeById(s, 'a5+1').category).toBe('resolved')
  })

  it('flags on-plant statuses not updated for more than 5 weeks as stale', () => {
    expect(nodeById(s, 'a30')).toMatchObject({ status: 'SetFruit', weeksSinceUpdate: 7, stale: true })
    expect(nodeById(s, 'a29')).toMatchObject({ status: 'SetFruit', weeksSinceUpdate: 5, stale: false })
    expect(nodeById(s, 'a2')).toMatchObject({ status: 'Aborted', stale: false }) // resolved is never stale
    expect(isStale('none', null)).toBe(false)
  })

  it('counts weeks across ISO-year boundaries (2026 has a W53)', () => {
    expect(weeksBetween({ year: 2026, week: 52 }, { year: 2027, week: 2 })).toBe(3)
    expect(isoWeekIndex(2027, 1) - isoWeekIndex(2026, 53)).toBe(1)
  })
})

describe('growth readings', () => {
  const s = stemById(s1.id)

  it('span the previous reading’s top node → this reading’s top node', () => {
    const byWeek = Object.fromEntries(s.growth.map((g) => [g.week, g]))
    expect(byWeek[30]).toMatchObject({ fromNode: 14, toNode: 15, cm: 7.5 })
    expect(byWeek[32]).toMatchObject({ fromNode: 15, toNode: 19 })
    expect(byWeek[32].yTop).toBe(nodeY(twin.baseY, 19))
    expect(byWeek[32].yBottom).toBe(nodeY(twin.baseY, 15))
  })

  it('mark the first placed reading at its own top node, and stack readings on the same top node', () => {
    const byWeek = Object.fromEntries(s.growth.map((g) => [g.week, g]))
    expect(byWeek[29]).toMatchObject({ fromNode: 14, toNode: 14, stackIndex: 0 })
    expect(byWeek[33]).toMatchObject({ fromNode: 19, toNode: 19, stackIndex: 1, latest: true })
    expect(s.growth.filter((g) => g.latest)).toHaveLength(1)
  })

  it('never overlap their labels, even when sections are close or share a top node', () => {
    const ys = s.growth.map((g) => g.labelY).sort((a, b) => a - b)
    for (let i = 1; i < ys.length; i++) expect(ys[i] - ys[i - 1]).toBeGreaterThanOrEqual(GROWTH_LABEL_GAP)
    const w32 = s.growth.find((g) => g.week === 32)!
    expect(w32.labelY).toBeLessThanOrEqual((w32.yTop + w32.yBottom) / 2)
  })

  it('keep readings without a top node out of the drawing, with their notes', () => {
    expect(s.unplacedGrowth).toEqual([{ id: 'g25', cm: 9.5, year: 2026, week: 25, notes: 'started measuring' }])
    expect(s.growth.some((g) => g.id === 'g25')).toBe(false)
  })

  it('restart after a reading that cannot be positioned', () => {
    const { growth } = placeGrowth([reading('x', 's', 30, 8, 10), reading('y', 's', 31, 8, null), reading('z', 's', 32, 9, 13)], 900)
    expect(growth.find((g) => g.id === 'z')).toMatchObject({ fromNode: 13, toNode: 13 })
  })
})

describe('duplicate records', () => {
  // Node 3 has two shoots both labelled 3+1 (one an empty double tap) and a 3+2.
  const st = stem('stem-d', 'Stem D', 1)
  const n3 = main('d3', st.id, 3)
  const twinOf = (nodes: PlantNode[]) => buildTwin({ row: null, stems: [st], nodes, statuses: [], growth: [] }, NOW).stems[0]
  const dupA = { ...shoot('d3+1a', st.id, n3, 1, 'right'), created_at: '2026-06-05T13:29:20.054Z' }
  const dupB = { ...shoot('d3+1b', st.id, n3, 1, 'right'), created_at: '2026-06-05T13:29:20.535Z' }
  const second = shoot('d3+2', st.id, n3, 2, 'right')

  it('flags side shoots sharing a label and lists them as a problem', () => {
    const t = twinOf([main('d1', st.id, 1), main('d2', st.id, 2), n3, dupA, dupB, second])
    expect(t.duplicateShootLabels).toEqual(['3+1'])
    expect(t.problems).toEqual([{ key: 'shoot:d3:3+1', kind: 'shoot', label: '3+1', nodeIds: ['d3+1a', 'd3+1b'] }])
    const [a, b, c] = t.branches[0].nodes
    expect([a.duplicate, b.duplicate, c.duplicate]).toEqual([{ count: 2, index: 0 }, { count: 2, index: 1 }, null])
  })

  it('draws duplicate shoots side by side across the branch, not on top of each other', () => {
    const [a, b, c] = twinOf([n3, dupA, dupB, second]).branches[0].nodes
    expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeCloseTo(SHOOT_DUPLICATE_SPREAD, 6)
    // Same distance along the branch from the parent; the 3+2 keeps its own place.
    const parent = twinOf([n3]).mainNodes[0]
    const along = (n: { x: number; y: number }) => (n.x - parent.x) * Math.cos(Math.PI * 35 / 180) - (n.y - parent.y) * Math.sin(Math.PI * 35 / 180)
    expect(along(a)).toBeCloseTo(SHOOT_FIRST, 6)
    expect(along(b)).toBeCloseTo(SHOOT_FIRST, 6)
    expect(along(c)).toBeCloseTo(SHOOT_FIRST + SHOOT_STEP, 6)
  })

  it('lists main-stem duplicates as problems, and ignores removed records', () => {
    const d12a = main('d12a', st.id, 12, '2026-07-17T11:18:48.639Z')
    const d12b = main('d12b', st.id, 12, '2026-07-17T11:18:48.653Z')
    const removed = { ...main('d12c', st.id, 12), is_active: false }
    const t = twinOf([n3, d12a, d12b, removed, { ...dupB, is_active: false }, dupA])
    expect(t.problems).toEqual([{ key: 'main:stem-d:12', kind: 'main', label: '12', nodeIds: ['d12a', 'd12b'] }])
    expect(t.duplicateShootLabels).toEqual([])
  })
})
