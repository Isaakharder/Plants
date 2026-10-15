// Breaker photo pairs for the desktop viewer: the front and back photos of
// one BreakerFruit observation, where the node was when they were taken, the
// node they are assigned to now (after any correction) and their latest
// colour estimate. Nothing here changes a record.

import type { NodePhotoRow, PhotoColourAnalysisRow, PhotoPairCorrectionRow } from '../../lib/database.types'

export type NodeInfo = { id: string; stemId: string; nodeNumber: number; label: string | null; isSideShoot: boolean }

/** A node's latest recorded status (node_latest_statuses). */
export type LatestStatus = { status: string; year: number; week: number }

/**
 * After a reassignment the Breaker record stays on the node where it was
 * recorded while the photos point at another node. That is never left
 * silent: this says whether the stage records agree with the photos, and
 * what to fix in the collector when they don't.
 */
export function assignmentCheck(recordedNode: string, recordedStatus: LatestStatus | undefined, photoNode: string, photoStatus: LatestStatus | undefined): { ok: boolean; message: string } {
  const ripe = (s: LatestStatus | undefined) => s?.status === 'BreakerFruit' || s?.status === 'Harvested'
  const label = (s: LatestStatus | undefined) => (s ? `${STATUS_NAME[s.status] ?? s.status} (W${s.week})` : 'no record')
  if (ripe(photoStatus) && !ripe(recordedStatus)) {
    return { ok: true, message: `${photoNode} is recorded as ${label(photoStatus)} and ${recordedNode} as ${label(recordedStatus)}: the records match the photos.` }
  }
  const fixes: string[] = []
  if (!ripe(photoStatus)) fixes.push(`record ${photoNode} as Breaker in the collector (now ${label(photoStatus)})`)
  if (ripe(recordedStatus)) fixes.push(`check ${recordedNode}, which is still recorded as ${label(recordedStatus)}`)
  return { ok: false, message: `Records disagree with the photos: ${fixes.join('; ')}.` }
}

const STATUS_NAME: Record<string, string> = {
  Flower: 'Flower',
  SetFruit: 'Set fruit',
  MatureGreen: 'Mature green',
  BreakerFruit: 'Breaker',
  Harvested: 'Harvested',
  Aborted: 'Aborted',
  Pruned: 'Pruned',
}
export type Place = { rowName: string; stemName: string; nodeName: string }

export type PhotoPair = {
  observationId: string
  cropId: string
  year: number
  week: number
  observedAt: string | null
  takenAt: string
  front: NodePhotoRow | null
  back: NodePhotoRow | null
  /** Where the photographed node was at capture (from the photo rows). */
  atCapture: Place
  /** 'as_captured', or the latest correction in effect (nodeId: the node the photos are reassigned to). */
  assignment: { kind: 'as_captured' | 'reassign_node' | 'unusable'; node: Place | null; nodeId: string | null; note: string | null; at: string | null }
  /** The node the Breaker record (and the photos, as stored) belong to. */
  recordedNodeId: string
  /** The newest colour estimate (a correction supersedes what it corrects); null when none yet. */
  colour: PhotoColourAnalysisRow | null
  colourHistory: PhotoColourAnalysisRow[]
}

export const nodeName = (n: { node_number?: number; nodeNumber?: number; node_label?: string | null; label?: string | null; is_side_shoot?: boolean; isSideShoot?: boolean }) => {
  const side = n.is_side_shoot ?? n.isSideShoot
  const label = n.node_label ?? n.label
  return side ? `Shoot ${label ?? ''}`.trim() : `Node ${n.node_number ?? n.nodeNumber}`
}

export function buildPairs(input: {
  photos: (NodePhotoRow & { observed_at?: string | null })[]
  analyses: PhotoColourAnalysisRow[]
  corrections: PhotoPairCorrectionRow[]
  stems: Map<string, { name: string; rowId: string }>
  rows: Map<string, string>
  nodes: Map<string, NodeInfo>
}): PhotoPair[] {
  const byObservation = new Map<string, (NodePhotoRow & { observed_at?: string | null })[]>()
  for (const p of input.photos) {
    let list = byObservation.get(p.node_observation_id)
    if (!list) byObservation.set(p.node_observation_id, (list = []))
    list.push(p)
  }
  const place = (stemId: string, node: string): Place => {
    const stem = input.stems.get(stemId)
    return { rowName: stem ? input.rows.get(stem.rowId) ?? 'Row ?' : 'Row ?', stemName: stem?.name ?? 'Stem ?', nodeName: node }
  }
  const pairs: PhotoPair[] = []
  for (const [observationId, photos] of byObservation) {
    // The latest photo of each side (a retake is a new photo of the same observation).
    const latest = (side: 'front' | 'back') => photos.filter((p) => p.side === side).sort((a, b) => b.taken_at.localeCompare(a.taken_at))[0] ?? null
    const front = latest('front')
    const back = latest('back')
    const any = front ?? back!
    const corrections = input.corrections.filter((c) => c.node_observation_id === observationId).sort((a, b) => b.created_at.localeCompare(a.created_at))
    const c = corrections[0]
    let assignment: PhotoPair['assignment'] = { kind: 'as_captured', node: null, nodeId: null, note: null, at: null }
    if (c?.kind === 'reassign_node' && c.corrected_node_id) {
      const n = input.nodes.get(c.corrected_node_id)
      assignment = { kind: 'reassign_node', node: n ? place(n.stemId, nodeName(n)) : null, nodeId: c.corrected_node_id, note: c.note, at: c.created_at }
    } else if (c?.kind === 'unusable') assignment = { kind: 'unusable', node: null, nodeId: null, note: c.note, at: c.created_at }
    const history = input.analyses.filter((a) => a.node_observation_id === observationId).sort((a, b) => b.created_at.localeCompare(a.created_at))
    pairs.push({
      observationId,
      cropId: any.crop_id,
      year: any.year,
      week: any.week_number,
      observedAt: any.observed_at ?? null,
      takenAt: any.taken_at,
      front,
      back,
      atCapture: place(any.measurement_stem_id, nodeName(any)),
      recordedNodeId: any.plant_node_id,
      assignment,
      colour: history[0] ?? null,
      colourHistory: history,
    })
  }
  return pairs.sort((a, b) => b.takenAt.localeCompare(a.takenAt))
}

/** Parses a typed percentage: blank → null, otherwise 0–100 with at most one decimal. */
export function parsePercent(text: string): number | null | 'invalid' {
  const s = text.trim().replace(',', '.').replace(/%$/, '')
  if (s === '') return null
  if (!/^\d{1,3}(\.\d)?$/.test(s)) return 'invalid'
  const n = Number(s)
  return n >= 0 && n <= 100 ? n : 'invalid'
}

/**
 * The combined percentage of a pair: what was typed, or else the mean of
 * front and back (each photo shows about half the pepper).
 */
export function combinedPercent(front: number | null, back: number | null, typed: number | null): number | null {
  if (typed !== null) return typed
  if (front !== null && back !== null) return Math.round(((front + back) / 2) * 10) / 10
  return front ?? back
}
