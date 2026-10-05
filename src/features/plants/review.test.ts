import { describe, expect, it } from 'vitest'
import type { NodeStatus, PlantNode } from '../collector/types'
import { buildTimeline, diagnose, nearbyMissingNumbers, neighbourhood, summarizeRecord, type Observation } from './review'

const stamp = (i: number) => `2026-07-17T11:18:48.${String(600 + i).padStart(3, '0')}Z`
const main = (id: string, n: number, i = 0, extra: Partial<PlantNode> = {}): PlantNode => ({
  id, organization_id: 'org', crop_id: 'crop', measurement_stem_id: 'stem', node_number: n, sort_order: n,
  is_side_shoot: false, parent_node_id: null, node_label: null, side: null, is_active: true,
  created_by: null, created_at: stamp(i), updated_at: `2026-08-0${(i % 9) + 1}T00:00:00Z`, ...extra,
})
const shoot = (id: string, parent: PlantNode, k: number, side: 'left' | 'right' = 'right', extra: Partial<PlantNode> = {}): PlantNode =>
  main(id, parent.node_number, 0, { is_side_shoot: true, parent_node_id: parent.id, node_label: `${parent.node_number}+${k}`, side, ...extra })
let seq = 0
const obs = (nodeId: string, week: number, status: NodeStatus, year = 2026): Observation => ({
  id: `o${++seq}`, plant_node_id: nodeId, year, week_number: week, status,
  observed_at: `${year}-01-01T00:00:${String(seq % 60).padStart(2, '0')}Z`, recorded_at: `${year}-01-01T00:00:00Z`,
})

// Modelled on Row 27 / Stem 9: four records labelled 12, 13–15 missing.
const below = Array.from({ length: 11 }, (_, i) => main(`n${i + 1}`, i + 1))
const a = main('42d385b3-aaaa', 12, 1)
const b = main('5704b89a-bbbb', 12, 2)
const c = main('b0c1a118-cccc', 12, 3)
const d = main('4704dabc-dddd', 12, 4)
const a1 = shoot('60b35189-eeee', a, 1, 'left')
const above = [main('n16', 16), main('n17', 17)]
const stemNodes = [...below, a, b, c, d, a1, ...above]
const observations = [
  obs(a.id, 29, 'SetFruit'), obs(a.id, 33, 'MatureGreen'), obs(a.id, 35, 'Aborted'),
  obs(b.id, 29, 'Flower'), obs(b.id, 30, 'SetFruit'), obs(b.id, 35, 'MatureGreen'), obs(b.id, 38, 'Harvested'),
  obs(c.id, 30, 'SetFruit'), obs(c.id, 35, 'MatureGreen'), obs(c.id, 40, 'Harvested'),
  obs(d.id, 30, 'SetFruit'), obs(d.id, 35, 'BreakerFruit'),
  obs(a1.id, 29, 'Flower'), obs(a1.id, 30, 'Pruned'),
]
const records = [a, b, c, d].map((n) => summarizeRecord(n, stemNodes, observations))

describe('record summaries', () => {
  it('counts observations, first/latest, created week and attached shoots', () => {
    const [ra, rb] = records
    expect(ra.observations).toHaveLength(3)
    expect(ra.first).toMatchObject({ week_number: 29, status: 'SetFruit' })
    expect(ra.latest).toMatchObject({ week_number: 35, status: 'Aborted' })
    expect(ra.createdWeek).toEqual({ year: 2026, week: 29 })
    expect(ra.children).toEqual([{ node: a1, observationCount: 2, latest: expect.objectContaining({ status: 'Pruned' }) }])
    expect(rb.children).toEqual([])
    const empty = summarizeRecord(main('empty', 30), stemNodes, observations)
    expect([empty.observations.length, empty.first, empty.latest]).toEqual([0, null, null])
  })
})

describe('shared timeline', () => {
  it('lays out every week from first to last and marks weeks updated on several records', () => {
    const t = buildTimeline(records)
    expect(t.weeks.map((w) => w.week)).toEqual([29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40])
    expect([...t.sharedWeeks].sort()).toEqual(['2026-W29', '2026-W30', '2026-W35'])
    expect(t.cells.get(d.id)?.get('2026-W35')).toBe('BreakerFruit')
    expect(t.cells.get(a.id)?.get('2026-W31')).toBeUndefined()
  })

  it('crosses ISO years (2026 has 53 weeks)', () => {
    const r = summarizeRecord(main('y', 3), [], [obs('y', 52, 'Flower'), obs('y', 2, 'SetFruit', 2027)])
    expect(buildTimeline([r]).weeks.map((w) => `${w.year}-${w.week}`)).toEqual(['2026-52', '2026-53', '2027-1', '2027-2'])
  })

  it('is empty when nothing was observed', () => {
    expect(buildTimeline([summarizeRecord(main('z', 3), [], [])]).weeks).toEqual([])
  })
})

describe('diagnosis', () => {
  it('describes the Row 27 / Stem 9 case without choosing numbers', () => {
    const lines = diagnose(records, stemNodes, buildTimeline(records))
    expect(lines).toEqual([
      '4 records are labelled Node 12.',
      'Nearby node numbers 13, 14 and 15 are missing.',
      'These records were updated independently in the same weeks (W29, W30 and W35), so they appear to represent different physical nodes.',
    ])
  })

  it('says when no nearby number is missing (Row 101 / Stem 13)', () => {
    const nodes = Array.from({ length: 6 }, (_, i) => main(`m${i + 1}`, i + 1)).concat(main('m2b', 2, 5))
    const recs = [nodes[1], nodes[6]].map((n) => summarizeRecord(n, nodes, [obs(n.id, 28, 'MatureGreen')]))
    expect(diagnose(recs, nodes, buildTimeline(recs))[1]).toBe('No node numbers near 2 are missing, so there is no obvious number to move a record to.')
  })

  it('points out an empty record next to a duplicate shoot (Row 101 / Stem 2)', () => {
    const p = main('p3', 3)
    const s1 = shoot('7782613a-x', p, 1)
    const s2 = shoot('b62f2700-y', p, 1)
    const recs = [s1, s2].map((n) => summarizeRecord(n, [p, s1, s2], [obs(s2.id, 23, 'Flower')]))
    expect(diagnose(recs, [p, s1, s2], buildTimeline(recs))).toEqual([
      '2 side-shoot records are labelled 3+1 on node 3.',
      'Record 7782613a has no observations — possibly an accidental double tap.',
    ])
  })

  it('does not claim different nodes when the histories never overlap', () => {
    const x = main('x', 12)
    const y = main('y', 12, 1)
    const recs = [summarizeRecord(x, [x, y], [obs('x', 30, 'SetFruit')]), summarizeRecord(y, [x, y], [obs('y', 35, 'MatureGreen')])]
    expect(diagnose(recs, [x, y], buildTimeline(recs)).at(-1)).toMatch(/never fall in the same week/)
  })

  it('has nothing to say about a single record', () => {
    expect(diagnose([records[0]], stemNodes, buildTimeline([records[0]]))).toEqual([])
  })
})

describe('missing numbers near a duplicate', () => {
  it('lists missing nearby numbers, closest first', () => {
    expect(nearbyMissingNumbers(stemNodes, 12, 4)).toEqual([13, 14, 15])
    // Row 28 / Stem 11: 23 twice, 24 missing.
    const s11 = [...Array.from({ length: 27 }, (_, i) => i + 1).filter((n) => n !== 24), 23].map((n, i) => main(`s${i}`, n))
    expect(nearbyMissingNumbers(s11, 23, 2)).toEqual([24])
    // Removed records don't occupy a number.
    expect(nearbyMissingNumbers([...s11, main('gone', 24, 0, { is_active: false })], 23, 2)).toEqual([24])
  })

  it('shows the numbers around a duplicate with their record counts', () => {
    expect(neighbourhood(stemNodes, 12, 4)).toEqual([
      { number: 9, records: 1 }, { number: 10, records: 1 }, { number: 11, records: 1 }, { number: 12, records: 4 },
      { number: 13, records: 0 }, { number: 14, records: 0 }, { number: 15, records: 0 }, { number: 16, records: 1 }, { number: 17, records: 1 },
    ])
  })
})
