// Merges writes that are still in the offline queue into data read from the
// server, so the collector shows what the worker recorded before it syncs.
//
// Replaces CropLink's in-memory optimisticStore.ts. That store was lost on
// reload and needed temp-ID remapping; this one is derived from the durable
// queue (which survives reloads) and the IDs never change.
// Every function is idempotent: applying it to already-merged data is a no-op.

import type { HarvestableMark, LatestNodeStatus, MobileRowCard, RowCanvasData, StemGrowthMeasurement, StemVisit, WeekProgressData } from '../types'
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
  const visits = new Map((data.visits ?? []).map((v) => [v.id, v]))
  const harvestable = new Map((data.harvestable ?? []).map((m) => [m.id, m]))
  const answers = new Map((data.answers ?? []).map((x) => [x.node_observation_id, x]))

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
      case 'record_stem_visit':
        if (stems.some((s) => s.id === a.record.measurement_stem_id)) visits.set(a.record.id, stemVisitOf(a.record))
        break
      case 'record_harvestable':
        if (nodes.some((n) => n.id === a.record.plant_node_id)) harvestable.set(a.record.id, harvestableMarkOf(a.record))
        break
      case 'record_inspection_answer':
        if (nodes.some((n) => n.id === a.plantNodeId)) {
          answers.set(a.record.node_observation_id, {
            node_observation_id: a.record.node_observation_id,
            harvest_event_id: a.record.harvest_event_id,
            plant_node_id: a.plantNodeId,
            status: a.answerStatus,
            observed_at: a.observedAt,
          })
        }
        break
    }
  }

  return {
    row,
    stems,
    nodes,
    statuses: [...statuses.values()],
    growth: [...growth.values()],
    visits: [...visits.values()],
    harvestable: [...harvestable.values()],
    answers: [...answers.values()],
  }
}

const harvestableMarkOf = (r: HarvestableMark): HarvestableMark => ({
  id: r.id,
  plant_node_id: r.plant_node_id,
  year: r.year,
  week_number: r.week_number,
  harvestable: r.harvestable,
  observed_at: r.observed_at,
})

/** Nodes marked Harvestable in a greenhouse week: the latest mark per node in that week wins (a false takes it back). */
export function harvestableNodes(marks: readonly HarvestableMark[], week: { year: number; week: number }): Map<string, HarvestableMark> {
  const latest = new Map<string, HarvestableMark>()
  for (const m of marks) {
    if (m.year !== week.year || m.week_number !== week.week) continue
    const cur = latest.get(m.plant_node_id)
    if (!cur || m.observed_at >= cur.observed_at) latest.set(m.plant_node_id, m)
  }
  for (const [id, m] of latest) if (!m.harvestable) latest.delete(id)
  return latest
}

const stemVisitOf = (r: StemVisit): StemVisit => ({
  id: r.id,
  measurement_stem_id: r.measurement_stem_id,
  year: r.year,
  week_number: r.week_number,
  checked: r.checked,
  observed_at: r.observed_at,
  harvest_event_id: r.harvest_event_id ?? null,
  all_fruit_checked: r.all_fruit_checked ?? null,
})

/** Adds queued stem checks and sampling completions to the home screen's week progress. */
export function mergeWeekProgress(data: WeekProgressData, queued: QueuedAction[]): WeekProgressData {
  const visits = new Map(data.visits.map((v) => [v.id, v]))
  const events = new Map(data.events.map((e) => [e.id, e]))
  const observations = new Map((data.observations ?? []).map((o) => [o.id, o]))
  for (const a of queued) {
    if (a.type === 'record_status') {
      const { id, crop_id, plant_node_id, year, week_number, status, observed_at } = a.record
      observations.set(id, { id, crop_id, plant_node_id, stem_id: a.stemId ?? null, year, week_number, status, observed_at })
    }
    if (a.type === 'record_stem_visit') visits.set(a.record.id, { ...stemVisitOf(a.record), crop_id: a.record.crop_id })
    if (a.type === 'record_sampling_event') {
      const { id, crop_id, year, week_number, event, observed_at } = a.record
      events.set(id, { id, crop_id, year, week_number, event, observed_at })
    }
  }
  return { visits: [...visits.values()], events: [...events.values()], observations: [...observations.values()] }
}
