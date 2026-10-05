// Merges writes that are still in the offline queue into data read from the
// server, so the collector shows what the worker recorded before it syncs.
//
// Replaces CropLink's in-memory optimisticStore.ts. That store was lost on
// reload and needed temp-ID remapping; this one is derived from the durable
// queue (which survives reloads) and the IDs never change.
// Every function is idempotent: applying it to already-merged data is a no-op.

import type { LatestNodeStatus, MobileRowCard, RowCanvasData, StemGrowthMeasurement } from '../types'
import type { QueuedAction } from './offlineQueue'

const stamp = (a: QueuedAction) => {
  const at = new Date(a.createdAt).toISOString()
  return { created_by: a.userId, created_at: at, updated_at: at }
}

/** Is a newer than b? Same ordering as the node_latest_statuses view. */
export function isNewerStatus(a: Pick<LatestNodeStatus, 'year' | 'week_number' | 'observed_at'>, b: Pick<LatestNodeStatus, 'year' | 'week_number' | 'observed_at'>): boolean {
  if (a.year !== b.year) return a.year > b.year
  if (a.week_number !== b.week_number) return a.week_number > b.week_number
  return a.observed_at >= b.observed_at
}

export function mergeRowCards(cards: MobileRowCard[], organizationId: string, queued: QueuedAction[]): MobileRowCard[] {
  const result = [...cards]
  const known = new Set(cards.map((c) => c.id))
  for (const a of queued) {
    if (a.type === 'create_row' && a.record.organization_id === organizationId && !known.has(a.record.id)) {
      const at = new Date(a.createdAt).toISOString()
      result.push({ id: a.record.id, row_name: a.record.row_name, crop_id: a.record.crop_id, sort_order: a.record.sort_order, stem_ids: [], stem_count: 0, last_updated: at })
      known.add(a.record.id)
    }
  }
  return result.map((card) => {
    const stemIds = new Set(card.stem_ids)
    let lastUpdated = card.last_updated
    for (const a of queued) {
      if (a.type === 'create_stem' && a.record.measurement_row_id === card.id && !stemIds.has(a.record.id)) {
        stemIds.add(a.record.id)
        const at = new Date(a.createdAt).toISOString()
        if (at > lastUpdated) lastUpdated = at
      }
    }
    if (stemIds.size === card.stem_ids.length) return card
    return { ...card, stem_ids: [...stemIds], stem_count: stemIds.size, last_updated: lastUpdated }
  })
}

export function mergeRowCanvas(data: RowCanvasData, rowId: string, queued: QueuedAction[]): RowCanvasData {
  let row = data.row
  const stems = [...data.stems]
  let nodes = [...data.nodes]
  const statuses = new Map(data.statuses.map((s) => [s.plant_node_id, s]))
  const growth = new Map(data.growth.map((g) => [`${g.measurement_stem_id}:${g.year}:${g.week_number}`, g]))

  for (const a of queued) {
    switch (a.type) {
      case 'create_row':
        if (!row && a.record.id === rowId) row = { ...a.record, ...stamp(a) }
        break
      case 'create_stem':
        if (a.record.measurement_row_id === rowId && !stems.some((s) => s.id === a.record.id)) stems.push({ ...a.record, ...stamp(a) })
        break
      case 'create_node':
        if (stems.some((s) => s.id === a.record.measurement_stem_id) && !nodes.some((n) => n.id === a.record.id)) {
          // The time the worker added it (older queued writes don't carry one: the queue time).
          nodes.push({ ...a.record, ...stamp(a), created_at: a.record.created_at ?? stamp(a).created_at })
        }
        break
      case 'deactivate_node':
        nodes = nodes.map((n) => (n.id === a.record.id ? { ...n, is_active: false } : n))
        break
      case 'record_status': {
        if (!nodes.some((n) => n.id === a.record.plant_node_id)) break
        const current = statuses.get(a.record.plant_node_id)
        const next: LatestNodeStatus = {
          id: a.record.id,
          plant_node_id: a.record.plant_node_id,
          year: a.record.year,
          week_number: a.record.week_number,
          status: a.record.status,
          observed_at: a.record.observed_at,
        }
        if (!current || isNewerStatus(next, current)) statuses.set(next.plant_node_id, next)
        break
      }
      case 'upsert_growth':
        if (stems.some((s) => s.id === a.record.measurement_stem_id)) {
          const key = `${a.record.measurement_stem_id}:${a.record.year}:${a.record.week_number}`
          const reading: StemGrowthMeasurement = { ...a.record, ...stamp(a) }
          growth.set(key, reading)
        }
        break
    }
  }

  return { row, stems, nodes, statuses: [...statuses.values()], growth: [...growth.values()] }
}
