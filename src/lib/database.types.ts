// Mirrors supabase/migrations. Regenerate once the project is linked:
//   npx supabase gen types typescript --linked > src/lib/database.types.ts

export type CropColor = 'red' | 'orange' | 'yellow' | 'green' | 'other'

/** Node statuses the mobile collector records (node_observations.status). */
export type NodeStatus = 'Aborted' | 'Pruned' | 'Flower' | 'SetFruit' | 'MatureGreen' | 'BreakerFruit' | 'Harvested'

type OrganizationRow = {
  id: string
  name: string
  created_at: string
  updated_at: string
}

type CropRow = {
  id: string
  organization_id: string
  name: string
  color: CropColor
  planting_date: string
  pullout_date: string
  area_m2: number
  picking_stems: number
  created_by: string | null
  created_at: string
  updated_at: string
}

// ---- Mobile collector (20261006000000_mobile_collector.sql) ----
// IDs are generated in the browser, so Insert requires them.

type MeasurementRowRow = {
  id: string
  organization_id: string
  crop_id: string
  row_name: string
  sort_order: number
  is_active: boolean
  created_by: string | null
  created_at: string
  updated_at: string
}

type MeasurementStemRow = {
  id: string
  organization_id: string
  crop_id: string
  measurement_row_id: string
  stem_name: string
  sort_order: number
  is_active: boolean
  created_by: string | null
  created_at: string
  updated_at: string
}

type PlantNodeRow = {
  id: string
  organization_id: string
  crop_id: string
  measurement_stem_id: string
  node_number: number
  sort_order: number
  is_side_shoot: boolean
  parent_node_id: string | null
  node_label: string | null
  side: 'left' | 'right' | null
  is_active: boolean
  created_by: string | null
  created_at: string
  updated_at: string
}

type NodeObservationRow = {
  id: string
  organization_id: string
  crop_id: string
  plant_node_id: string
  year: number
  week_number: number
  status: NodeStatus
  observed_at: string
  recorded_at: string
  created_by: string | null
}

type StemGrowthMeasurementRow = {
  id: string
  organization_id: string
  crop_id: string
  measurement_stem_id: string
  year: number
  week_number: number
  growth_cm: number
  top_node_number: number | null
  notes: string | null
  observed_at: string
  created_by: string | null
  created_at: string
  updated_at: string
}

type ServerManaged = 'created_by' | 'created_at' | 'updated_at'

// ---- Mobile attention rules (20261013000000_node_attention_rules.sql) ----

/** A node status, or 'NoStatus' for a node that has never been observed (not a node status). */
export type AttentionRuleKey = NodeStatus | 'NoStatus'

/** How many days a node may go without an update, by its latest status, before the collector shows its clock. */
export type NodeAttentionRuleRow = {
  organization_id: string
  rule_key: AttentionRuleKey
  max_days: number
  updated_by: string | null
  created_at: string
  updated_at: string
}

// ---- Mobile status options (20261018000000_mobile_status_options.sql) ----

/** Whether the mobile collector offers a status for new entries (no row = offered). Never affects recorded statuses. */
export type MobileStatusOptionRow = {
  organization_id: string
  status: NodeStatus
  enabled: boolean
  updated_by: string | null
  created_at: string
  updated_at: string
}

// ---- Manual AFW per harvest week (20261015000000_cohort_afw.sql, renamed in 20261016000000_weekly_harvest_afw.sql) ----

/** Average grams per pepper harvested in one ISO week (year, week) of a crop, entered by hand. */
export type WeeklyHarvestAfwRow = {
  organization_id: string
  crop_id: string
  year: number
  week: number
  afw_g: number
  updated_by: string | null
  created_at: string
  updated_at: string
}

// ---- Fruit Loss % per calendar week (20261017000000_weekly_fruit_loss.sql) ----

/** One ISO week: fruit lost that week ÷ fruit on the plant at its start. Percent and per-m² are null when unsampled. */
export type WeeklyFruitLossRow = {
  iso_week: number
  /** Fruit on the plant at the start of the week (set before it, not yet harvested or lost, on a sampled stem). */
  fruit_at_start: number
  /** Of those, confirmed lost this week (fruit_aborted + fruit_pruned). */
  fruit_lost: number
  fruit_aborted: number
  fruit_pruned: number
  /** Losses of nodes never recorded as fruit (flowers); not part of Fruit Loss %. */
  flower_lost: number
  fruit_lost_per_m2: number | null
  fruit_loss_percent: number | null
  is_sampled: boolean
  is_provisional: boolean
}

// ---- Projections (20261007000000_weekly_plant_data.sql) ----

/** One ISO week of observed stage entries on a crop's sampled plants. Per-m² values are null when unsampled. */
export type WeeklyPlantDataRow = {
  iso_week: number
  sampled_stems: number
  sampled_m2: number | null
  new_sets: number
  new_breakers: number
  new_harvested: number
  sets_per_m2: number | null
  breakers_per_m2: number | null
  harvested_per_m2: number | null
  is_sampled: boolean
  is_baseline: boolean
  is_provisional: boolean
}

// ---- Set → Harvest cohort ladder (20261009000000_cohort_ladder.sql; +10 window: 20261010000000_cohort_window_10.sql) ----

/** One cell of a harvest-week row: the cohort set `delay` (+0 … +10) weeks earlier. */
export type CohortCell = {
  delay: number
  set_year: number
  set_week: number
  /** Every pepper first recorded SetFruit in that week (the denominator). */
  cohort_sets: number
  /** Of those, first recorded Harvested in this row's week, i.e. at exactly +delay. */
  harvested: number
  /** harvested ÷ cohort_sets × 100; null when there is no cohort or this week wasn't sampled (—). */
  percent: number | null
  is_baseline_cohort: boolean
  /** The whole cohort's outcome so far; they sum to cohort_sets. Timeout only once closed. */
  cohort_harvested: number
  cohort_aborted: number
  cohort_pruned: number
  cohort_timeout: number
  cohort_on_plant: number
  /** Its +10 week is over and was sampled. */
  cohort_closed: boolean
}

/** The cohort whose +10 window ends in this row’s week. */
export type ClosingCohort = {
  set_year: number
  set_week: number
  sets: number
  harvested: number
  aborted: number
  pruned: number
  timeout: number
  on_plant: number
  closed: boolean
  is_baseline_cohort: boolean
  /** (aborted + pruned + timeout) ÷ sets × 100 once closed; null (—) while open or without sets. */
  loss_percent: number | null
}

export type SetHarvestCohortRow = {
  iso_week: number
  is_sampled: boolean
  is_provisional: boolean
  /** Raw Harvested (weekly_plant_data) = in_window + without_set + after_timeout. */
  harvested_total: number
  harvested_in_window: number
  harvested_without_set: number
  harvested_after_timeout: number
  /** +0 … +10, in order. */
  cells: CohortCell[]
  closing: ClosingCohort
}

export type Database = {
  public: {
    Tables: {
      organizations: {
        Row: OrganizationRow
        Insert: never
        Update: { name?: string }
        Relationships: []
      }
      organization_members: {
        Row: {
          organization_id: string
          user_id: string
          role: 'owner' | 'member'
          created_at: string
        }
        Insert: never
        Update: never
        Relationships: [
          {
            foreignKeyName: 'organization_members_organization_id_fkey'
            columns: ['organization_id']
            isOneToOne: false
            referencedRelation: 'organizations'
            referencedColumns: ['id']
          },
        ]
      }
      crops: {
        Row: CropRow
        Insert: Omit<CropRow, 'id' | 'created_by' | 'created_at' | 'updated_at'>
        Update: Partial<Omit<CropRow, 'id' | 'organization_id' | 'created_by' | 'created_at' | 'updated_at'>>
        Relationships: []
      }
      measurement_rows: {
        Row: MeasurementRowRow
        Insert: Omit<MeasurementRowRow, ServerManaged>
        Update: Partial<Pick<MeasurementRowRow, 'row_name' | 'sort_order' | 'is_active'>>
        Relationships: [
          {
            foreignKeyName: 'measurement_rows_crop_fkey'
            columns: ['organization_id', 'crop_id']
            isOneToOne: false
            referencedRelation: 'crops'
            referencedColumns: ['organization_id', 'id']
          },
        ]
      }
      measurement_stems: {
        Row: MeasurementStemRow
        Insert: Omit<MeasurementStemRow, ServerManaged>
        Update: Partial<Pick<MeasurementStemRow, 'stem_name' | 'sort_order' | 'is_active'>>
        Relationships: [
          {
            foreignKeyName: 'measurement_stems_row_fkey'
            columns: ['organization_id', 'crop_id', 'measurement_row_id']
            isOneToOne: false
            referencedRelation: 'measurement_rows'
            referencedColumns: ['organization_id', 'crop_id', 'id']
          },
        ]
      }
      plant_nodes: {
        Row: PlantNodeRow
        // created_at: when the node was added on the phone (validated by the database).
        Insert: Omit<PlantNodeRow, ServerManaged> & { created_at?: string }
        Update: Partial<Pick<PlantNodeRow, 'is_active'>>
        Relationships: [
          {
            foreignKeyName: 'plant_nodes_parent_fkey'
            columns: ['measurement_stem_id', 'parent_node_id']
            isOneToOne: false
            referencedRelation: 'plant_nodes'
            referencedColumns: ['measurement_stem_id', 'id']
          },
          {
            foreignKeyName: 'plant_nodes_stem_fkey'
            columns: ['organization_id', 'crop_id', 'measurement_stem_id']
            isOneToOne: false
            referencedRelation: 'measurement_stems'
            referencedColumns: ['organization_id', 'crop_id', 'id']
          },
        ]
      }
      node_observations: {
        Row: NodeObservationRow
        Insert: Omit<NodeObservationRow, 'recorded_at' | 'created_by'>
        Update: never
        Relationships: [
          {
            foreignKeyName: 'node_observations_node_fkey'
            columns: ['organization_id', 'crop_id', 'plant_node_id']
            isOneToOne: false
            referencedRelation: 'plant_nodes'
            referencedColumns: ['organization_id', 'crop_id', 'id']
          },
        ]
      }
      stem_growth_measurements: {
        Row: StemGrowthMeasurementRow
        Insert: Omit<StemGrowthMeasurementRow, ServerManaged>
        Update: Partial<Omit<StemGrowthMeasurementRow, ServerManaged>>
        Relationships: [
          {
            foreignKeyName: 'stem_growth_measurements_stem_fkey'
            columns: ['organization_id', 'crop_id', 'measurement_stem_id']
            isOneToOne: false
            referencedRelation: 'measurement_stems'
            referencedColumns: ['organization_id', 'crop_id', 'id']
          },
        ]
      }
      weekly_harvest_afw: {
        Row: WeeklyHarvestAfwRow
        Insert: Pick<WeeklyHarvestAfwRow, 'organization_id' | 'crop_id' | 'year' | 'week' | 'afw_g'>
        Update: Pick<WeeklyHarvestAfwRow, 'afw_g'>
        Relationships: []
      }
      node_attention_rules: {
        Row: NodeAttentionRuleRow
        Insert: Pick<NodeAttentionRuleRow, 'organization_id' | 'rule_key' | 'max_days'>
        Update: Pick<NodeAttentionRuleRow, 'max_days'>
        Relationships: []
      }
      mobile_status_options: {
        Row: MobileStatusOptionRow
        Insert: Pick<MobileStatusOptionRow, 'organization_id' | 'status' | 'enabled'>
        Update: Pick<MobileStatusOptionRow, 'enabled'>
        Relationships: []
      }
    }
    Views: {
      node_latest_statuses: {
        Row: Omit<NodeObservationRow, 'created_by'> & { measurement_stem_id: string; measurement_row_id: string }
        Relationships: []
      }
    }
    Functions: {
      create_organization: {
        Args: { org_name: string }
        Returns: OrganizationRow
      }
      weekly_plant_data: {
        Args: { p_crop_id: string; p_year: number; p_as_of?: string }
        Returns: WeeklyPlantDataRow[]
      }
      set_harvest_cohorts: {
        Args: { p_crop_id: string; p_year: number; p_as_of?: string }
        Returns: SetHarvestCohortRow[]
      }
      weekly_fruit_loss: {
        Args: { p_crop_id: string; p_year: number; p_as_of?: string }
        Returns: WeeklyFruitLossRow[]
      }
    }
    Enums: Record<string, never>
    CompositeTypes: Record<string, never>
  }
}
