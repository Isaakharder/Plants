// Harvests page data: harvests are written only through record_harvest_event()
// (it validates the whole harvest); inspections, links and the inventory are
// computed by the database. Everything is read with the user's RLS.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '../../lib/supabase'
import { fetchAll } from '../collector/fetchAll'
import type { FruitHarvestLinkRow, HarvestEventInEffect, HarvestRange, InspectionStemRow, StemInventoryRow } from '../../lib/database.types'
import type { RowRef } from './model'

export const harvestKeys = {
  all: ['harvests'] as const,
  rows: (orgId: string) => ['harvests', 'rows', orgId] as const,
  events: (orgId: string, cropId: string) => ['harvests', 'events', orgId, cropId] as const,
  inspections: (cropId: string) => ['harvests', 'inspections', cropId] as const,
  links: (cropId: string) => ['harvests', 'links', cropId] as const,
  inventory: (cropId: string) => ['harvests', 'inventory', cropId] as const,
  nodes: (cropId: string) => ['harvests', 'nodes', cropId] as const,
  workflowFrom: (cropId: string) => ['harvests', 'workflowFrom', cropId] as const,
}

function check<T>(res: { data: T | null; error: { message: string } | null }): T {
  if (res.error) throw new Error(res.error.message)
  return res.data as T
}

const num = (v: unknown) => (v === null || v === undefined ? null : Number(v))

export const normalizeEvent = (e: HarvestEventInEffect): HarvestEventInEffect => ({
  ...e,
  min_colour_percent: Number(e.min_colour_percent),
  harvested_kg: num(e.harvested_kg),
})

/** Every active sampled row of the organization (to check ranges against every variety's rows). */
export function useOrganizationRows(organizationId: string) {
  return useQuery({
    queryKey: harvestKeys.rows(organizationId),
    queryFn: async (): Promise<RowRef[]> =>
      fetchAll((after, limit, withCount) => {
        let q = supabase.from('measurement_rows').select('id, row_name, crop_id', withCount ? { count: 'exact' } : undefined).eq('organization_id', organizationId).eq('is_active', true)
        if (after) q = q.gt('id', after)
        return q.order('id').limit(limit)
      }, (r) => r.id),
  })
}

export function useHarvestEvents(organizationId: string, cropId: string | null) {
  return useQuery({
    queryKey: harvestKeys.events(organizationId, cropId ?? ''),
    enabled: Boolean(cropId),
    queryFn: async () => check(await supabase.rpc('harvest_events_in_effect', { p_organization_id: organizationId, p_crop_id: cropId })).map(normalizeEvent),
  })
}

/** Every version of one harvest, oldest first (its history). */
export function useHarvestVersions(eventId: string | null) {
  return useQuery({
    queryKey: ['harvests', 'versions', eventId],
    enabled: Boolean(eventId),
    queryFn: async () => {
      const versions = check(
        await supabase.from('harvest_events').select('id, harvest_date, min_colour_percent, harvested_kg, note, cancelled, recorded_at, recorded_by').eq('event_id', eventId!).order('recorded_at'),
      )
      const ranges = versions.length
        ? check(await supabase.from('harvest_event_ranges').select('harvest_event_version_id, position, from_row, to_row, coverage').in('harvest_event_version_id', versions.map((v) => v.id)))
        : []
      return versions.map((v) => ({
        ...v,
        min_colour_percent: Number(v.min_colour_percent),
        harvested_kg: num(v.harvested_kg),
        ranges: ranges
          .filter((r) => r.harvest_event_version_id === v.id)
          .sort((x, y) => x.position - y.position)
          .map((r): HarvestRange => ({ from: r.from_row, to: r.to_row, coverage: r.coverage })),
      }))
    },
  })
}

export type HarvestInput = {
  cropId: string
  harvestDate: string
  minColourPercent: number
  ranges: HarvestRange[]
  harvestedKg: number | null
  note: string | null
  /** The version being corrected (or cancelled). */
  replacesId?: string | null
  cancel?: boolean
}

export function useRecordHarvest(organizationId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (input: HarvestInput & { id: string }) =>
      check(
        await supabase.rpc('record_harvest_event', {
          p_crop_id: input.cropId,
          p_harvest_date: input.cancel ? null : input.harvestDate,
          p_min_colour_percent: input.cancel ? null : input.minColourPercent,
          p_ranges: input.cancel ? null : input.ranges,
          p_harvested_kg: input.cancel ? null : input.harvestedKg,
          p_note: input.note,
          p_replaces_id: input.replacesId ?? null,
          p_cancel: input.cancel ?? false,
          // Made here, so a retry after a lost response returns the same version.
          p_id: input.id,
        }),
      )[0],
    onSuccess: (_d, input) => {
      void qc.invalidateQueries({ queryKey: harvestKeys.events(organizationId, input.cropId) })
      void qc.invalidateQueries({ queryKey: harvestKeys.inspections(input.cropId) })
      void qc.invalidateQueries({ queryKey: harvestKeys.links(input.cropId) })
      void qc.invalidateQueries({ queryKey: harvestKeys.workflowFrom(input.cropId) })
    },
  })
}

export function useInspectionStems(cropId: string | null) {
  return useQuery({
    queryKey: harvestKeys.inspections(cropId ?? ''),
    enabled: Boolean(cropId),
    queryFn: async (): Promise<InspectionStemRow[]> => check(await supabase.rpc('post_harvest_inspection_stems', { p_crop_id: cropId! })),
  })
}

export function useHarvestLinks(cropId: string | null) {
  return useQuery({
    queryKey: harvestKeys.links(cropId ?? ''),
    enabled: Boolean(cropId),
    queryFn: async (): Promise<FruitHarvestLinkRow[]> => check(await supabase.rpc('fruit_harvest_links', { p_crop_id: cropId! })),
  })
}

export function useStemInventory(cropId: string | null) {
  return useQuery({
    queryKey: harvestKeys.inventory(cropId ?? ''),
    enabled: Boolean(cropId),
    queryFn: async (): Promise<StemInventoryRow[]> => check(await supabase.rpc('stem_inventory_latest', { p_crop_id: cropId! })),
  })
}

/** The first ISO week (yyyyww) of the post-harvest workflow for the variety, or null. */
export function useWorkflowFrom(cropId: string | null) {
  return useQuery({
    queryKey: harvestKeys.workflowFrom(cropId ?? ''),
    enabled: Boolean(cropId),
    queryFn: async () => check(await supabase.rpc('post_harvest_workflow_from', { p_crop_id: cropId! })) as number | null,
  })
}

/** Node labels ("Node 5", "5+1") of the variety's nodes, for the links table. */
export function useNodeLabels(cropId: string | null) {
  return useQuery({
    queryKey: harvestKeys.nodes(cropId ?? ''),
    enabled: Boolean(cropId),
    queryFn: async () => {
      const nodes = await fetchAll((after, limit, withCount) => {
        let q = supabase.from('plant_nodes').select('id, node_number, node_label, is_side_shoot', withCount ? { count: 'exact' } : undefined).eq('crop_id', cropId!)
        if (after) q = q.gt('id', after)
        return q.order('id').limit(limit)
      }, (n) => n.id)
      return new Map(nodes.map((n) => [n.id, n.is_side_shoot ? n.node_label ?? 'Shoot' : `Node ${n.node_number}`]))
    },
  })
}

export function useReviewLink(organizationId: string, cropId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (r: { link: FruitHarvestLinkRow; decision: 'confirmed' | 'rejected' | 'unreviewed'; eventId: string | null; note: string | null }) =>
      check(
        await supabase.from('harvest_link_reviews').insert({
          organization_id: organizationId,
          crop_id: cropId,
          node_observation_id: r.link.node_observation_id,
          decision: r.decision,
          harvest_event_id: r.decision === 'confirmed' ? r.eventId : null,
          note: r.note,
          link_snapshot: r.link as unknown as Record<string, unknown>,
        }),
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: harvestKeys.links(cropId) }),
  })
}
