import { describe, expect, it } from 'vitest'
import type { NodePhotoRow, PhotoColourAnalysisRow, PhotoPairCorrectionRow } from '../../lib/database.types'
import { assignmentCheck, buildPairs, combinedPercent, parsePercent } from './model'

const photo = (id: string, obs: string, side: 'front' | 'back', takenAt: string, over: Partial<NodePhotoRow> = {}): NodePhotoRow => ({
  id, organization_id: 'o', crop_id: 'c', plant_node_id: 'n12', node_observation_id: obs, side, measurement_stem_id: 's9', measurement_row_id: 'r27',
  node_number: 12, node_label: null, is_side_shoot: false, target_colour: 'red', year: 2026, week_number: 42, storage_path: `o/c/n12/${id}.jpg`,
  preview_path: `o/c/n12/${id}.preview.jpg`, content_type: 'image/jpeg', bytes: 3_000_000, width: 3024, height: 4032, sha256: 'a'.repeat(64),
  taken_at: takenAt, recorded_at: takenAt, capture_meta: {}, created_by: 'u', ...over,
})
const analysis = (id: string, obs: string, at: string, pct: number, over: Partial<PhotoColourAnalysisRow> = {}): PhotoColourAnalysisRow => ({
  id, organization_id: 'o', crop_id: 'c', node_observation_id: obs, front_photo_id: null, back_photo_id: null, kind: 'manual', method: 'visual-estimate',
  model_version: 'v1', target_colour: 'red', front_percent: null, back_percent: null, combined_percent: pct, confidence: null, details: {},
  supersedes_id: null, note: null, created_at: at, created_by: 'u', ...over,
})
const correction = (obs: string, at: string, kind: PhotoPairCorrectionRow['kind'], node: string | null = null): PhotoPairCorrectionRow => ({
  id: `${obs}-${at}`, organization_id: 'o', crop_id: 'c', node_observation_id: obs, kind, corrected_node_id: node, note: kind === 'reassign_node' ? 'next node up' : null,
  created_at: at, created_by: 'u',
})
const maps = {
  stems: new Map([['s9', { name: 'Stem 9', rowId: 'r27' }]]),
  rows: new Map([['r27', 'Row 27']]),
  nodes: new Map([['n13', { id: 'n13', stemId: 's9', nodeNumber: 13, label: null, isSideShoot: false }]]),
}

describe('buildPairs', () => {
  const photos = [
    photo('f1', 'o1', 'front', '2026-10-16T14:00:01Z'),
    photo('b1', 'o1', 'back', '2026-10-16T14:00:09Z'),
    photo('f2', 'o2', 'front', '2026-10-16T15:00:00Z', { plant_node_id: 'n5', node_number: 5, is_side_shoot: true, node_label: '5+1' }),
    photo('f2b', 'o2', 'front', '2026-10-16T15:00:30Z', { plant_node_id: 'n5', node_number: 5, is_side_shoot: true, node_label: '5+1' }),
  ]

  it('pairs front and back of each observation, newest first, with where the node was at capture', () => {
    const pairs = buildPairs({ photos, analyses: [], corrections: [], ...maps })
    expect(pairs.map((p) => p.observationId)).toEqual(['o2', 'o1'])
    const o1 = pairs[1]
    expect([o1.front?.id, o1.back?.id]).toEqual(['f1', 'b1'])
    expect(o1.atCapture).toEqual({ rowName: 'Row 27', stemName: 'Stem 9', nodeName: 'Node 12' })
    expect(pairs[0].atCapture.nodeName).toBe('Shoot 5+1')
    // A retaken front: the latest one is shown; the earlier one is kept, never deleted.
    expect(pairs[0].front?.id).toBe('f2b')
    expect(pairs[0].back).toBeNull()
  })

  it('applies the latest correction: reassigned, unusable, or restored as captured', () => {
    const reassigned = buildPairs({ photos, analyses: [], corrections: [correction('o1', '2026-10-17T09:00:00Z', 'reassign_node', 'n13')], ...maps })
    expect(reassigned.find((p) => p.observationId === 'o1')!.assignment).toMatchObject({ kind: 'reassign_node', node: { nodeName: 'Node 13', stemName: 'Stem 9' }, note: 'next node up' })
    const restored = buildPairs({
      photos, analyses: [], ...maps,
      corrections: [correction('o1', '2026-10-17T09:00:00Z', 'reassign_node', 'n13'), correction('o1', '2026-10-17T10:00:00Z', 'restore')],
    })
    expect(restored.find((p) => p.observationId === 'o1')!.assignment.kind).toBe('as_captured')
    const unusable = buildPairs({ photos, analyses: [], corrections: [correction('o1', '2026-10-17T09:00:00Z', 'unusable')], ...maps })
    expect(unusable.find((p) => p.observationId === 'o1')!.assignment.kind).toBe('unusable')
  })

  it('shows the newest colour estimate and keeps the history', () => {
    const pairs = buildPairs({
      photos, corrections: [], ...maps,
      analyses: [analysis('a1', 'o1', '2026-10-17T09:00:00Z', 20), analysis('a2', 'o1', '2026-10-17T11:00:00Z', 25, { kind: 'correction', supersedes_id: 'a1' })],
    })
    const o1 = pairs.find((p) => p.observationId === 'o1')!
    expect(o1.colour?.combined_percent).toBe(25)
    expect(o1.colourHistory.map((a) => a.id)).toEqual(['a2', 'a1'])
    expect(pairs.find((p) => p.observationId === 'o2')!.colour).toBeNull()
  })
})

describe('percent entry', () => {
  it('parses 0–100 with one decimal; blank is empty', () => {
    expect(parsePercent('35')).toBe(35)
    expect(parsePercent(' 12,5% ')).toBe(12.5)
    expect(parsePercent('')).toBeNull()
    expect(parsePercent('101')).toBe('invalid')
    expect(parsePercent('abc')).toBe('invalid')
  })
  it('combines front and back as their mean unless a combined value is typed', () => {
    expect(combinedPercent(30, 10, null)).toBe(20)
    expect(combinedPercent(30, 10, 25)).toBe(25)
    expect(combinedPercent(40, null, null)).toBe(40)
    expect(combinedPercent(null, null, null)).toBeNull()
  })
})

describe('assignmentCheck', () => {
  const st = (status: string, week = 42) => ({ status, year: 2026, week })
  it('agrees when the photographed node is Breaker and the recorded one has been corrected', () => {
    expect(assignmentCheck('Node 12', st('MatureGreen'), 'Node 13', st('BreakerFruit'))).toMatchObject({ ok: true })
  })
  it('says what to fix when the stage records still disagree with the photos', () => {
    const r = assignmentCheck('Node 12', st('BreakerFruit'), 'Node 13', st('SetFruit', 41))
    expect(r.ok).toBe(false)
    expect(r.message).toBe('Records disagree with the photos: record Node 13 as Breaker in the collector (now Set fruit (W41)); check Node 12, which is still recorded as Breaker (W42).')
    expect(assignmentCheck('Node 12', st('BreakerFruit'), 'Node 13', st('BreakerFruit')).ok).toBe(false)
  })
})
