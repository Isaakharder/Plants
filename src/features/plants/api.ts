import { useQuery } from '@tanstack/react-query'
import { supabase } from '../../lib/supabase'
import { fetchRowCanvas } from '../collector/api'
import { fetchAll } from '../collector/fetchAll'
import type { MeasurementRow } from '../collector/types'
import type { Observation } from './review'

// The Plants page reads exactly what the mobile collector reads (fetchRowCanvas:
// stems, nodes, latest statuses and growth for a row, each read in full past
// Supabase's 1,000-row limit). There is no separate digital-twin dataset.

/**
 * One row's current collector data. Always fetched fresh: when the page opens,
 * when the row changes and when the browser window regains focus (plus the
 * page's Refresh button), so new nodes, statuses, shoots and growth readings
 * recorded on a phone show up without a reload.
 */
export const plantsRowQuery = (rowId: string) => ({
  queryKey: ['plants', 'row', rowId] as const,
  queryFn: () => fetchRowCanvas(rowId),
  staleTime: 0,
  refetchOnMount: 'always' as const,
  refetchOnWindowFocus: 'always' as const,
})

export function usePlantsRow(rowId: string | undefined) {
  return useQuery({ ...plantsRowQuery(rowId ?? ''), enabled: Boolean(rowId) })
}

/** The variety's active rows, in collector order. */
export function useCropRows(cropId: string | undefined) {
  return useQuery({
    queryKey: ['plants', 'rows', cropId] as const,
    enabled: Boolean(cropId),
    staleTime: 0,
    refetchOnWindowFocus: 'always',
    queryFn: async (): Promise<Pick<MeasurementRow, 'id' | 'row_name' | 'sort_order'>[]> => {
      const rows = await fetchAll((after, limit, withCount) => {
        let q = supabase
          .from('measurement_rows')
          .select('id, row_name, sort_order', withCount ? { count: 'exact' } : undefined)
          .eq('crop_id', cropId!)
          .eq('is_active', true)
        if (after) q = q.gt('id', after)
        return q.order('id').limit(limit)
      }, (r) => r.id)
      return rows.sort((a, b) => a.sort_order - b.sort_order || a.row_name.localeCompare(b.row_name, undefined, { numeric: true }))
    },
  })
}

// ── Review panel ────────────────────────────────────────────────────────────

/** Full observation history of a few nodes (the records open in the review panel). Read-only. */
export function useNodeObservations(nodeIds: string[]) {
  const ids = [...nodeIds].sort()
  return useQuery({
    queryKey: ['plants', 'observations', ids] as const,
    enabled: ids.length > 0,
    staleTime: 0,
    refetchOnWindowFocus: 'always',
    queryFn: () =>
      fetchAll<Observation>((after, limit, withCount) => {
        let q = supabase
          .from('node_observations')
          .select('id, plant_node_id, year, week_number, status, observed_at, recorded_at', withCount ? { count: 'exact' } : undefined)
          .in('plant_node_id', ids)
        if (after) q = q.gt('id', after)
        return q.order('id').limit(limit)
      }, (o) => o.id),
  })
}
