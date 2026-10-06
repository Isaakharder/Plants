// Collector data access, rewritten for Plants.
//
// CropLink's collector called an Express server that used the service-role
// key. Here every read is a direct Supabase query as the signed-in user, so
// Row Level Security limits it to the user's organization, and every write
// goes through the device's offline queue (offline/offlineQueue.ts).

import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { useCallback, useMemo, useSyncExternalStore } from 'react'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../auth/AuthProvider'
import { useOrganization } from '../organization/OrganizationProvider'
import { DEFAULT_ATTENTION_RULES, rulesFromRows, type AttentionRules } from './attention'
import { fetchAll, IncompleteReadError } from './fetchAll'
import { enabledFromRows, statusOptionsOrDefaults, type EnabledStatuses } from './statusOptions'
import { currentGreenhouseWeek } from './greenhouseWeek'
import { newId } from './offline/ids'
import { collectorQueue, triggerSync } from './offline/networkStatus'
import type { QueuedAction, QueuedWrite } from './offline/offlineQueue'
import { mergeRowCanvas, mergeRowCards } from './offline/optimisticStore'
import type {
  CollectorCrop,
  LatestNodeStatus,
  MeasurementRow,
  MeasurementStem,
  MobileRowCard,
  NodeStatus,
  PlantNode,
  RowCanvasData,
  StemGrowthMeasurement,
} from './types'

export const collectorKeys = {
  all: ['collector'] as const,
  crops: (organizationId: string) => ['collector', 'crops', organizationId] as const,
  rowCards: (organizationId: string) => ['collector', 'rowCards', organizationId] as const,
  row: (rowId: string) => ['collector', 'row', rowId] as const,
  attentionRules: (organizationId: string) => ['collector', 'attentionRules', organizationId] as const,
  statusOptions: (organizationId: string) => ['collector', 'statusOptions', organizationId] as const,
}

/** Offline, with nothing for this screen saved on the device. */
export class NotOnDeviceError extends Error {}

const failedForNetwork = (err: unknown) => !navigator.onLine || (err as { status?: number }).status === 0

function check<T>(res: { data: T | null; error: { message: string } | null; status: number }): T {
  if (res.error) throw Object.assign(new Error(res.error.message), { status: res.status })
  return res.data as T
}

/**
 * Builds a collector query that keeps working without a connection.
 *
 * The query function always runs (networkMode 'always'). It reads from the
 * server when it can; when the network fails it starts from the copy already
 * on the device (restored from IndexedDB at startup). Either way it then adds
 * the writes still waiting in the offline queue, so the screen shows what the
 * worker recorded. Writes that sync while the read is in flight are included
 * too: the server copy may predate them while the queue no longer holds them.
 */
function collectorQuery<T>(
  queryClient: QueryClient,
  queryKey: readonly unknown[],
  userId: string,
  read: () => Promise<T>,
  merge: (base: T | undefined, queued: QueuedAction[]) => T | undefined,
) {
  return {
    queryKey,
    queryFn: async (): Promise<T> => {
      const queue = collectorQueue()
      await queue.ready
      const before = queue.list(userId)
      let base: T | undefined
      try {
        if (!navigator.onLine) throw Object.assign(new Error('offline'), { status: 0 })
        base = await read()
      } catch (err) {
        if (!failedForNetwork(err)) throw err
        base = queryClient.getQueryData<T>(queryKey)
      }
      const after = queue.list(userId)
      const seen = new Set(after.map((a) => a.id))
      const queued = [...before.filter((a) => !seen.has(a.id) && !queue.wasWithdrawn(a.id)), ...after].sort((a, b) => a.createdAt - b.createdAt)
      const merged = merge(base, queued)
      if (merged === undefined) throw new NotOnDeviceError('Not available offline on this device yet.')
      return merged
    },
    networkMode: 'always' as const,
    // Keep collector data in memory long enough that it stays in the saved copy.
    gcTime: 7 * 24 * 60 * 60 * 1000,
    retry: (failures: number, err: Error) => !(err instanceof NotOnDeviceError) && failures < 1,
    refetchOnReconnect: 'always' as const,
  }
}

// ── Reads ──────────────────────────────────────────────────────────────────

/**
 * This user's queued writes, re-read whenever the queue changes. Screens merge
 * them in at render time, so they always match the durable queue even when
 * the copy of server data they start from is older (e.g. restored after the
 * phone killed the app).
 */
function useQueuedWrites(userId: string): QueuedAction[] {
  const queue = collectorQueue()
  return useSyncExternalStore(
    useCallback((fn) => queue.subscribe(fn), [queue]),
    () => queue.snapshot(userId),
  )
}

export function useCollectorCrops(organizationId: string, userId: string) {
  const queryClient = useQueryClient()
  return useQuery(
    collectorQuery<CollectorCrop[]>(
      queryClient,
      collectorKeys.crops(organizationId),
      userId,
      async () => {
        // One request keeps the server's name ordering; the count makes a
        // truncated response an error instead of a silently shorter list.
        const res = await supabase
          .from('crops')
          .select('id, name, color, planting_date, pullout_date', { count: 'exact' })
          .eq('organization_id', organizationId)
          .order('name')
        const crops = check(res)
        if (res.count !== null && crops.length < res.count) throw new IncompleteReadError(`Loaded ${crops.length} of ${res.count} varieties. Try again.`)
        return crops
      },
      (base) => base,
    ),
  )
}

/** The organization's mobile attention rules (one small read; a few rows per organization). */
export async function fetchAttentionRules(organizationId: string): Promise<AttentionRules> {
  const res = await supabase.from('node_attention_rules').select('rule_key, max_days').eq('organization_id', organizationId)
  return rulesFromRows(check(res))
}

/** Exported for tests. */
export const attentionRulesQuery = (queryClient: QueryClient, organizationId: string, userId: string) => ({
  ...collectorQuery<AttentionRules>(queryClient, collectorKeys.attentionRules(organizationId), userId, () => fetchAttentionRules(organizationId), (base) => base),
  // One tiny request: re-check whenever the home screen or a row opens, so a
  // change in Settings reaches the phone on its next sync, not 30 s later.
  staleTime: 0,
})

/**
 * The rules the clock badges use. Saved on the device with the other collector
 * data, so offline the last downloaded rules apply. Only a device that has
 * never downloaded them falls back to the documented defaults; those are never
 * written into the saved copy, so they can't replace the organization's rules.
 */
export function useAttentionRules(organizationId: string, userId: string) {
  return rulesOrDefaults(useQuery(attentionRulesQuery(useQueryClient(), organizationId, userId)).data)
}

/** The downloaded rules, or the defaults on a device that has never had them. */
export function rulesOrDefaults(downloaded: AttentionRules | undefined): { rules: AttentionRules; source: 'organization' | 'defaults' } {
  return downloaded ? { rules: downloaded, source: 'organization' } : { rules: DEFAULT_ATTENTION_RULES, source: 'defaults' }
}

/** The statuses the organization offers for new entries (one small read; seven rows per organization). */
export async function fetchMobileStatusOptions(organizationId: string): Promise<EnabledStatuses> {
  const res = await supabase.from('mobile_status_options').select('status, enabled').eq('organization_id', organizationId)
  return enabledFromRows(check(res))
}

/** Exported for tests. Saved on the device and refreshed like the attention rules. */
export const mobileStatusOptionsQuery = (queryClient: QueryClient, organizationId: string, userId: string) => ({
  ...collectorQuery<EnabledStatuses>(queryClient, collectorKeys.statusOptions(organizationId), userId, () => fetchMobileStatusOptions(organizationId), (base) => base),
  staleTime: 0,
})

/**
 * The statuses the picker offers. Offline (or if the read fails) the last
 * downloaded choice applies; a device that has never downloaded it offers
 * every status, without saving that as the organization's choice.
 */
export function useMobileStatusOptions(organizationId: string, userId: string) {
  return statusOptionsOrDefaults(useQuery(mobileStatusOptionsQuery(useQueryClient(), organizationId, userId)).data)
}

async function fetchRowCards(organizationId: string): Promise<MobileRowCard[]> {
  // Read in full (fetchAll.ts); the home page orders the cards itself.
  const rows = await fetchAll((after, limit, withCount) => {
    let q = supabase
      .from('measurement_rows')
      .select('id, row_name, crop_id, sort_order, updated_at, measurement_stems(id, is_active, updated_at)', withCount ? { count: 'exact' } : undefined)
      .eq('organization_id', organizationId)
      .eq('is_active', true)
    if (after) q = q.gt('id', after)
    return q.order('id').limit(limit)
  }, (r) => r.id)
  return rows.map((row) => {
    const activeStems = (row.measurement_stems ?? []).filter((s) => s.is_active)
    return {
      id: row.id,
      row_name: row.row_name,
      crop_id: row.crop_id,
      sort_order: row.sort_order,
      stem_ids: activeStems.map((s) => s.id),
      stem_count: activeStems.length,
      last_updated: activeStems.reduce((max, s) => (s.updated_at > max ? s.updated_at : max), row.updated_at),
    }
  })
}

/** Row cards for every crop in the organization (the page filters to active crops). */
export function useRowCards(organizationId: string, userId: string) {
  const queryClient = useQueryClient()
  const queued = useQueuedWrites(userId)
  return useQuery({
    ...collectorQuery<MobileRowCard[]>(queryClient, collectorKeys.rowCards(organizationId), userId, () => fetchRowCards(organizationId), (base, queued) =>
      base === undefined && !queued.some((a) => a.type === 'create_row') ? undefined : mergeRowCards(base ?? [], organizationId, queued),
    ),
    select: useCallback((cards: MobileRowCard[]) => mergeRowCards(cards, organizationId, queued), [organizationId, queued]),
  })
}

// Every list the canvas needs is read in full (see fetchAll.ts): a row can
// hold more than 1,000 nodes, latest statuses (one per node) and growth
// readings (stems × weeks). Pages are keyed on a unique column; the canvas
// sorts nodes and stems itself, so the order records arrive in doesn't matter.
export async function fetchRowCanvas(rowId: string): Promise<RowCanvasData> {
  const count = (withCount: boolean) => (withCount ? { count: 'exact' as const } : undefined)
  const [row, stems, nodes, statuses, growth] = await Promise.all([
    supabase.from('measurement_rows').select('*').eq('id', rowId).maybeSingle().then(check),
    fetchAll((after, limit, withCount) => {
      let q = supabase.from('measurement_stems').select('*', count(withCount)).eq('measurement_row_id', rowId)
      if (after) q = q.gt('id', after)
      return q.order('id').limit(limit)
    }, (s) => s.id),
    fetchAll((after, limit, withCount) => {
      let q = supabase
        .from('plant_nodes')
        .select('*, measurement_stems!inner(measurement_row_id)', count(withCount))
        .eq('measurement_stems.measurement_row_id', rowId)
      if (after) q = q.gt('id', after)
      return q.order('id').limit(limit)
    }, (n) => n.id),
    // Latest status per node across all weeks: a status carries forward until
    // someone records a new one (otherwise every node looks blank on Monday).
    // The view returns one record per node, so plant_node_id is unique here.
    fetchAll((after, limit, withCount) => {
      let q = supabase
        .from('node_latest_statuses')
        .select('id, plant_node_id, year, week_number, status, observed_at', count(withCount))
        .eq('measurement_row_id', rowId)
      if (after) q = q.gt('plant_node_id', after)
      return q.order('plant_node_id').limit(limit)
    }, (s) => s.plant_node_id),
    fetchAll((after, limit, withCount) => {
      let q = supabase
        .from('stem_growth_measurements')
        .select('*, measurement_stems!inner(measurement_row_id)', count(withCount))
        .eq('measurement_stems.measurement_row_id', rowId)
      if (after) q = q.gt('id', after)
      return q.order('id').limit(limit)
    }, (g) => g.id),
  ])
  return {
    row,
    stems,
    nodes: nodes.map(({ measurement_stems: _stem, ...node }) => node),
    statuses,
    growth: growth.map(({ measurement_stems: _stem, ...reading }) => ({ ...reading, growth_cm: Number(reading.growth_cm) })),
  }
}

const EMPTY_CANVAS: RowCanvasData = { row: null, stems: [], nodes: [], statuses: [], growth: [] }

/** Exported for tests. */
export const rowCanvasQuery = (queryClient: QueryClient, rowId: string, userId: string) =>
  collectorQuery<RowCanvasData>(queryClient, collectorKeys.row(rowId), userId, () => fetchRowCanvas(rowId), (base, queued) => {
    const merged = mergeRowCanvas(base ?? EMPTY_CANVAS, rowId, queued)
    // Offline with no saved copy, unless the row itself was created on this device.
    return base === undefined && merged.row === null ? undefined : merged
  })

export function useRowCanvas(rowId: string, userId: string) {
  const queued = useQueuedWrites(userId)
  return useQuery({
    ...rowCanvasQuery(useQueryClient(), rowId, userId),
    select: useCallback((data: RowCanvasData) => mergeRowCanvas(data, rowId, queued), [rowId, queued]),
  })
}

/**
 * Loads rows the worker hasn't opened yet, a couple at a time, so they're on
 * the device if the greenhouse Wi-Fi drops before the worker reaches them.
 * Rows fetched within the last 10 minutes are skipped.
 */
export async function prefetchRowCanvases(queryClient: QueryClient, rowIds: string[], userId: string): Promise<void> {
  const queue = [...rowIds]
  const worker = async () => {
    for (let id = queue.shift(); id && navigator.onLine; id = queue.shift()) {
      await queryClient.prefetchQuery({ ...rowCanvasQuery(queryClient, id, userId), staleTime: 10 * 60 * 1000 }).catch(() => {})
    }
  }
  await Promise.all([worker(), worker()])
}

// ── Writes ─────────────────────────────────────────────────────────────────

/** Re-applies the queue to every collector query in the cache. */
function applyQueueToCache(queryClient: QueryClient, userId: string) {
  const queued = collectorQueue().list(userId)
  for (const query of queryClient.getQueryCache().findAll({ queryKey: collectorKeys.all })) {
    const [, kind, id] = query.queryKey as [string, string, string]
    if (kind === 'rowCards') {
      queryClient.setQueryData<MobileRowCard[]>(query.queryKey, (old) => old && mergeRowCards(old, id, queued))
    } else if (kind === 'row') {
      queryClient.setQueryData<RowCanvasData>(query.queryKey, (old) => mergeRowCanvas(old ?? { row: null, stems: [], nodes: [], statuses: [], growth: [] }, id, queued))
    }
  }
}

type NewNode = Pick<PlantNode, 'node_number' | 'sort_order'> & Partial<Pick<PlantNode, 'node_label' | 'parent_node_id' | 'side' | 'is_side_shoot'>>

/** Collector writes for the signed-in user's organization. All are queued first. */
export function useCollectorActions() {
  const queryClient = useQueryClient()
  const userId = useAuth().session!.user.id
  const organizationId = useOrganization().id

  return useMemo(() => {
    const queue = collectorQueue()
    const submit = async (write: QueuedWrite) => {
      await queue.enqueue(write, userId)
      applyQueueToCache(queryClient, userId)
      void triggerSync()
    }

    return {
      async createRow(cropId: string, rowName: string, sortOrder: number): Promise<MeasurementRow> {
        const record = { id: newId(), organization_id: organizationId, crop_id: cropId, row_name: rowName, sort_order: sortOrder, is_active: true }
        await submit({ type: 'create_row', record })
        // The home page lists rows from the rowCards query; make sure a row
        // created before that query ever loaded still appears.
        if (!queryClient.getQueryData(collectorKeys.rowCards(organizationId))) {
          queryClient.setQueryData(collectorKeys.rowCards(organizationId), mergeRowCards([], organizationId, queue.list(userId)))
        }
        const at = new Date().toISOString()
        return { ...record, created_by: userId, created_at: at, updated_at: at }
      },

      async createStem(row: MeasurementRow, stemName: string, sortOrder: number): Promise<MeasurementStem> {
        const record = {
          id: newId(),
          organization_id: row.organization_id,
          crop_id: row.crop_id,
          measurement_row_id: row.id,
          stem_name: stemName,
          sort_order: sortOrder,
          is_active: true,
        }
        await submit({ type: 'create_stem', record })
        const at = new Date().toISOString()
        return { ...record, created_by: userId, created_at: at, updated_at: at }
      },

      async createNode(stem: MeasurementStem, node: NewNode): Promise<PlantNode> {
        const record = {
          id: newId(),
          organization_id: stem.organization_id,
          crop_id: stem.crop_id,
          measurement_stem_id: stem.id,
          node_number: node.node_number,
          sort_order: node.sort_order,
          is_side_shoot: node.is_side_shoot ?? false,
          parent_node_id: node.parent_node_id ?? null,
          node_label: node.node_label ?? null,
          side: node.side ?? null,
          is_active: true,
          // When the worker added it, kept through the offline queue (the database checks it's plausible).
          created_at: new Date().toISOString(),
        }
        await submit({ type: 'create_node', record })
        return { ...record, created_by: userId, updated_at: record.created_at }
      },

      /** The status picker for a brand-new node was cancelled: remove the node. */
      async discardNewNode(node: PlantNode): Promise<void> {
        if (await queue.withdrawCreateNode(node.id)) {
          // Never sent: drop it from the cached canvas too.
          for (const query of queryClient.getQueryCache().findAll({ queryKey: ['collector', 'row'] })) {
            queryClient.setQueryData<RowCanvasData>(query.queryKey, (old) => old && { ...old, nodes: old.nodes.filter((n) => n.id !== node.id) })
          }
          return
        }
        await submit({ type: 'deactivate_node', record: { id: node.id, organization_id: node.organization_id, measurement_stem_id: node.measurement_stem_id } })
      },

      async recordStatus(node: PlantNode, status: NodeStatus): Promise<LatestNodeStatus> {
        // The week is taken now, at save time, not when the page was opened.
        const { year, week } = currentGreenhouseWeek()
        const record = {
          id: newId(),
          organization_id: node.organization_id,
          crop_id: node.crop_id,
          plant_node_id: node.id,
          year,
          week_number: week,
          status,
          observed_at: new Date().toISOString(),
        }
        await submit({ type: 'record_status', record })
        return record
      },

      async saveGrowth(stem: MeasurementStem, growthCm: number, notes: string | null, topNodeNumber: number | null, existing: StemGrowthMeasurement | null): Promise<StemGrowthMeasurement> {
        const { year, week } = currentGreenhouseWeek()
        // Correcting this week's reading keeps its ID; a new week gets a new one.
        const sameWeek = existing && existing.year === year && existing.week_number === week
        const record = {
          id: sameWeek ? existing.id : newId(),
          organization_id: stem.organization_id,
          crop_id: stem.crop_id,
          measurement_stem_id: stem.id,
          year,
          week_number: week,
          growth_cm: growthCm,
          // Snapshot of the stem when the reading was taken (CropLink computed
          // this on the server at sync time, which is wrong for offline saves).
          top_node_number: topNodeNumber,
          notes,
          observed_at: new Date().toISOString(),
        }
        await submit({ type: 'upsert_growth', record })
        const at = new Date().toISOString()
        return { ...record, created_by: userId, created_at: at, updated_at: at }
      },
    }
  }, [queryClient, userId, organizationId])
}
