// Breaker photos for the desktop viewer. Every read runs as the signed-in
// user (RLS); images come from the private bucket with the user's session
// and are shown through object URLs, never public links. Saving a colour
// estimate or a correction only ever adds a row.

import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { NodePhotoRow, PhotoColourAnalysisRow, PhotoPairCorrectionRow } from '../../lib/database.types'
import { supabase } from '../../lib/supabase'
import { fetchAll } from '../collector/fetchAll'
import { PHOTO_BUCKET } from '../collector/offline/photoUpload'
import type { Crop } from '../crops/model'
import { buildPairs, type LatestStatus, type NodeInfo, type PhotoPair } from './model'

const check = <T>(res: { data: T | null; error: { message: string } | null }): T => {
  if (res.error) throw new Error(res.error.message)
  return res.data as T
}
const count = (withCount: boolean) => (withCount ? { count: 'exact' as const } : undefined)
type Page<T> = PromiseLike<{ data: T[] | null; error: { message: string } | null; status: number; count?: number | null }>

export type PhotoData = {
  pairs: PhotoPair[]
  stems: { id: string; name: string; rowName: string }[]
  nodes: NodeInfo[]
  /** Each node's latest recorded status, to show whether stage records agree with reassigned photos. */
  statuses: Map<string, LatestStatus>
}

/** Photo pairs of a crop from a greenhouse week on (null: all weeks). */
export function usePhotoPairs(crop: Crop | undefined, since: { year: number; week: number } | null) {
  return useQuery({
    queryKey: ['photos', 'pairs', crop?.id, since?.year, since?.week],
    enabled: Boolean(crop),
    queryFn: async (): Promise<PhotoData> => {
      const photos = await fetchAll<NodePhotoRow & { node_observations: { observed_at: string } | null }>((after, limit, withCount) => {
        let q = supabase.from('node_photos').select('*, node_observations(observed_at)', count(withCount)).eq('crop_id', crop!.id)
        if (since) q = q.or(`year.gt.${since.year},and(year.eq.${since.year},week_number.gte.${since.week})`)
        if (after) q = q.gt('id', after)
        return q.order('id').limit(limit) as unknown as Page<NodePhotoRow & { node_observations: { observed_at: string } | null }>
      }, (p) => p.id)
      const observationIds = [...new Set(photos.map((p) => p.node_observation_id))]
      const inChunks = async <T>(table: 'photo_colour_analyses' | 'photo_pair_corrections'): Promise<T[]> => {
        const out: T[] = []
        for (let i = 0; i < observationIds.length; i += 200) {
          out.push(...(check(await supabase.from(table).select('*').in('node_observation_id', observationIds.slice(i, i + 200))) as T[]))
        }
        return out
      }
      const [analyses, corrections, rows, stems, nodes, latest] = await Promise.all([
        inChunks<PhotoColourAnalysisRow>('photo_colour_analyses'),
        inChunks<PhotoPairCorrectionRow>('photo_pair_corrections'),
        supabase.from('measurement_rows').select('id, row_name').eq('crop_id', crop!.id).then(check),
        supabase.from('measurement_stems').select('id, stem_name, measurement_row_id, sort_order').eq('crop_id', crop!.id).order('sort_order').then(check),
        fetchAll((after, limit, withCount) => {
          let q = supabase.from('plant_nodes').select('id, measurement_stem_id, node_number, node_label, is_side_shoot', count(withCount)).eq('crop_id', crop!.id).eq('is_active', true)
          if (after) q = q.gt('id', after)
          return q.order('id').limit(limit)
        }, (n) => n.id),
        fetchAll((after, limit, withCount) => {
          let q = supabase.from('node_latest_statuses').select('plant_node_id, status, year, week_number', count(withCount)).eq('crop_id', crop!.id)
          if (after) q = q.gt('plant_node_id', after)
          return q.order('plant_node_id').limit(limit)
        }, (s) => s.plant_node_id),
      ])
      const rowNames = new Map(rows.map((r) => [r.id, r.row_name]))
      const nodeInfo: NodeInfo[] = nodes.map((n) => ({ id: n.id, stemId: n.measurement_stem_id, nodeNumber: n.node_number, label: n.node_label, isSideShoot: n.is_side_shoot }))
      return {
        pairs: buildPairs({
          photos: photos.map(({ node_observations, ...p }) => ({ ...p, observed_at: node_observations?.observed_at ?? null })),
          analyses,
          corrections,
          stems: new Map(stems.map((s) => [s.id, { name: s.stem_name, rowId: s.measurement_row_id }])),
          rows: rowNames,
          nodes: new Map(nodeInfo.map((n) => [n.id, n])),
        }),
        stems: stems.map((s) => ({ id: s.id, name: s.stem_name, rowName: rowNames.get(s.measurement_row_id) ?? '' })),
        nodes: nodeInfo,
        statuses: new Map(latest.map((s) => [s.plant_node_id, { status: s.status, year: s.year, week: s.week_number }])),
      }
    },
  })
}

/** An image from the private bucket as an object URL (downloaded with the user's session). */
export function usePhotoImage(path: string | null | undefined) {
  return useQuery({
    queryKey: ['photos', 'image', path],
    enabled: Boolean(path),
    staleTime: Infinity,
    gcTime: 10 * 60 * 1000,
    queryFn: async () => {
      const { data, error } = await supabase.storage.from(PHOTO_BUCKET).download(path!)
      if (error) throw new Error(error.message)
      return URL.createObjectURL(data)
    },
  })
}

export function useRefreshPhotos() {
  const queryClient = useQueryClient()
  return () => queryClient.invalidateQueries({ queryKey: ['photos', 'pairs'] })
}

/** A person's colour estimate; a correction when the pair already has one (it supersedes, never overwrites). */
export async function addColourEstimate(pair: PhotoPair, values: { front: number | null; back: number | null; combined: number; note: string | null }) {
  const any = pair.front ?? pair.back!
  check(
    await supabase.from('photo_colour_analyses').insert({
      organization_id: any.organization_id,
      crop_id: pair.cropId,
      node_observation_id: pair.observationId,
      front_photo_id: pair.front?.id ?? null,
      back_photo_id: pair.back?.id ?? null,
      kind: pair.colour ? 'correction' : 'manual',
      supersedes_id: pair.colour?.id ?? null,
      method: 'visual-estimate',
      model_version: 'manual-v1',
      target_colour: any.target_colour,
      front_percent: values.front,
      back_percent: values.back,
      combined_percent: values.combined,
      note: values.note,
    }),
  )
}

/** Reassigns the pair to the node really photographed, marks it unusable, or restores it as captured. Photos and observations are untouched. */
export async function addPairCorrection(pair: PhotoPair, kind: PhotoPairCorrectionRow['kind'], correctedNodeId: string | null, note: string | null) {
  const any = pair.front ?? pair.back!
  check(
    await supabase.from('photo_pair_corrections').insert({
      organization_id: any.organization_id,
      crop_id: pair.cropId,
      node_observation_id: pair.observationId,
      kind,
      corrected_node_id: correctedNodeId,
      note,
    }),
  )
}
