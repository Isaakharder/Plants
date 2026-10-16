import type { CropColor, Database, NodeStatus } from '../../lib/database.types'

type Tables = Database['public']['Tables']

export type { NodeStatus }
export type MeasurementRow = Tables['measurement_rows']['Row']
export type MeasurementStem = Tables['measurement_stems']['Row']
export type PlantNode = Tables['plant_nodes']['Row']
export type NodeObservation = Tables['node_observations']['Row']
export type StemGrowthMeasurement = Tables['stem_growth_measurements']['Row']
export type StemVisit = Pick<Tables['stem_visits']['Row'], 'id' | 'measurement_stem_id' | 'year' | 'week_number' | 'checked' | 'observed_at'>
export type SamplingWeekEvent = Pick<Tables['sampling_week_events']['Row'], 'id' | 'crop_id' | 'year' | 'week_number' | 'event' | 'observed_at'>

/** A node's most recent observation (carried forward across weeks). */
export type LatestNodeStatus = Pick<NodeObservation, 'id' | 'plant_node_id' | 'year' | 'week_number' | 'status' | 'observed_at'>

/** The subset of a Plants crop the collector needs. */
export type CollectorCrop = {
  id: string
  name: string
  color: CropColor
  planting_date: string
  pullout_date: string
}

export type MobileRowCard = {
  id: string
  row_name: string
  crop_id: string
  sort_order: number
  /** Active stems (used to merge stems that are still queued). */
  stem_ids: string[]
  stem_count: number
  last_updated: string
}

/** Everything the row canvas shows for one row. */
export type RowCanvasData = {
  row: MeasurementRow | null
  stems: MeasurementStem[]
  nodes: PlantNode[]
  statuses: LatestNodeStatus[]
  growth: StemGrowthMeasurement[]
  /** “✓ Stem checked” records of this row's stems (recent weeks; the latest per stem and week wins). */
  visits: StemVisit[]
}

/** This organization's stem checks and sampling completions for the weeks the home screen shows. */
export type WeekProgressData = {
  visits: (StemVisit & { crop_id: string })[]
  events: SamplingWeekEvent[]
}

export const NODE_STATUSES = ['Aborted', 'Pruned', 'Flower', 'SetFruit', 'MatureGreen', 'BreakerFruit', 'Harvested'] as const satisfies readonly NodeStatus[]
