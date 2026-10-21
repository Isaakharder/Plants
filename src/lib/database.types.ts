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
  /** Kilograms per case for forecasts in cases; null = cases not shown. */
  case_weight_kg: number | null
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

// ---- Projections (20261007000000_weekly_plant_data.sql; sampled stems from visit evidence: 20261021000000_weekly_plant_data_visits.sql) ----

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

// ---- Sampling visits, completion and data quality (20261020000000_sampling_visits_and_quality.sql) ----
// Append-only: rows are inserted, never updated or deleted.

/** A worker confirmed a sampled stem was checked in a greenhouse week (checked = false retracts it). */
export type StemVisitRow = {
  id: string
  organization_id: string
  crop_id: string
  measurement_stem_id: string
  year: number
  week_number: number
  checked: boolean
  observed_at: string
  recorded_at: string
  created_by: string | null
}

/** A pepper marked ready to pick in a greenhouse week (harvestable = false takes it back). Never a node status. */
export type HarvestableMarkRow = {
  id: string
  organization_id: string
  crop_id: string
  plant_node_id: string
  year: number
  week_number: number
  harvestable: boolean
  observed_at: string
  recorded_at: string
  created_by: string | null
}

/** One ISO week's Harvestable count (weekly_harvestable()); weeks without marks are absent. */
export type WeeklyHarvestableRow = {
  iso_week: number
  /** Peppers marked Harvestable that week (latest mark per pepper). */
  harvestable: number
  /** Of those, recorded Harvested in the same week. */
  harvested_same_week: number
}

export type SamplingWeekEvent = 'completed' | 'reopened'

/** A crop's weekly sampling marked complete or reopened; the latest event per week is its state. */
export type SamplingWeekEventRow = {
  id: string
  organization_id: string
  crop_id: string
  year: number
  week_number: number
  event: SamplingWeekEvent
  note: string | null
  /** What the completing device showed: stems checked (synced or queued) of those in the sample. */
  stems_checked_seen: number | null
  stems_expected_seen: number | null
  observed_at: string
  recorded_at: string
  created_by: string | null
}

export type DataQualityDecision = 'recording_error' | 'legitimate' | 'unreviewed'

export type DataQualityReviewRow = {
  id: string
  organization_id: string
  crop_id: string
  flag_key: string
  rule_id: string
  decision: DataQualityDecision
  note: string | null
  flag_snapshot: unknown
  reviewed_at: string
  reviewed_by: string | null
}

export type SamplingWeekState = 'complete' | 'in_progress' | 'not_started' | 'legacy'

/** One ISO week's sampling coverage and completion (sampling_weeks()). */
export type SamplingWeekRow = {
  iso_week: number
  /** Active stems already in the sample (first visit in or before this week). */
  expected_stems: number
  /** Stems with visit evidence this week (a record, growth reading, new node or explicit check). */
  visited_stems: number
  /** Stems explicitly confirmed checked this week. */
  checked_stems: number
  unvisited_stems: number
  visited_m2: number | null
  /** visited ÷ expected, 0–1; null when no stem is expected yet. */
  coverage: number | null
  /** 'legacy': before explicit stem checks, only status changes were recorded. */
  tracking: 'explicit' | 'legacy'
  completion: SamplingWeekEvent | null
  completed_at: string | null
  state: SamplingWeekState
  is_provisional: boolean
}

export type QualityFlagCategory = 'coverage' | 'possible_recording_error' | 'unusual_crop_event'

/** A computed data-quality flag with its evidence and latest review (crop_quality_flags()). */
export type QualityFlagRow = {
  flag_key: string
  rule_id: string
  rule_version: number
  category: QualityFlagCategory
  scope: 'week' | 'stem_week' | 'node'
  yw: number
  week_start: string
  measurement_stem_id: string | null
  plant_node_id: string | null
  title: string
  explanation: string
  evidence: Record<string, unknown>
  /** null: never reviewed (or reopened). */
  review_decision: Exclude<DataQualityDecision, 'unreviewed'> | null
  review_note: string | null
  reviewed_at: string | null
  reviewed_by: string | null
}

// ---- Harvest Forecast snapshots (20261022000000_harvest_forecast_snapshots.sql) ----
// Read-only for clients: stored only through lock_forecast_run(); never updated or deleted.

export type ForecastRunRow = {
  id: string
  organization_id: string
  crop_id: string
  origin_year: number
  origin_week: number
  /** 'official': locked before its first target week began; 'late': after. */
  kind: 'official' | 'late'
  sampling_event_id: string
  observed_cutoff: string
  recorded_cutoff: string
  locked_at: string
  locked_by: string | null
  first_target_starts: string
  horizon: number
  marketing_weeks: number
  engine_version: string
  confidence: 'experimental' | 'standard'
  confidence_reasons: string[]
  model: unknown
  data_summary: unknown
  sample_stems: number
  /** The sampled stems the forecast covers (observed harvests are counted on these). */
  sample_stem_ids: string[]
  scale: number
  case_weight_kg: number | null
  /** Null when a marketing week isn't available (e.g. Breakers only). */
  marketing_sample_fruit: number | null
  marketing_crop_fruit: number | null
  marketing_kg: number | null
  /** 20261024: what the forecast rests on, and for Breakers only the share and how the Breakers were counted. */
  basis: 'lifecycle' | 'breaker_only'
  harvest_ready_share: number | null
  breaker_breakdown: BreakerBreakdownJson | null
  /** Stems checked or recorded that week ÷ stems in the sample. */
  coverage: number | null
}

export type BreakerBreakdownJson = { total: number; carriedOver: number; new: number; firstSeen: number; notRecordedAgain: number; possibleLaterCrop: number }

export type ForecastRunWeekRow = {
  run_id: string
  horizon: number
  target_year: number
  target_week: number
  window: 'marketing' | 'outlook'
  /** False: the basis can't support this week; no numbers are stored. */
  available: boolean
  sample_fruit: number | null
  sample_variance: number | null
  crop_fruit: number | null
  components: { breaker: number; matureGreen: number; setFruit: number; catchUp: number; newSets: number } | null
  expected_aborted: number | null
  expected_pruned: number | null
  afw_g: number | null
  afw_source: string | null
  afw_kind: 'grower' | 'model' | null
  kg: number | null
  cases: number | null
}

export type WeeklyHarvestAfwLogRow = {
  id: number
  organization_id: string
  crop_id: string
  year: number
  week: number
  afw_g: number | null
  action: 'baseline' | 'set' | 'clear'
  logged_at: string
  logged_by: string | null
}

export type LockForecastArgs = {
  p_run_id: string
  p_crop_id: string
  p_origin_year: number
  p_origin_week: number
  p_sampling_event_id: string
  p_recorded_cutoff: string
  p_horizon: number
  p_marketing_weeks: number
  p_engine_version: string
  p_confidence: 'experimental' | 'standard'
  p_confidence_reasons: string[]
  p_model: unknown
  p_data_summary: unknown
  p_sample_stems: number
  p_sample_stem_ids: string[]
  p_scale: number
  p_marketing: unknown
  p_weeks: unknown
  p_basis: 'lifecycle' | 'breaker_only'
  p_harvest_ready_share: number | null
  p_breaker_breakdown: unknown
  p_coverage: number | null
}

// ---- Forecast basis and actual harvest (20261024000000_breaker_forecast_and_actuals.sql) ----
// Append-only: a change or correction is a new row.

export type ForecastBasisSettingRow = {
  id: string
  organization_id: string
  crop_id: string
  from_year: number
  from_week: number
  basis: 'lifecycle' | 'breaker_only'
  harvest_ready_share: number | null
  note: string | null
  created_at: string
  created_by: string | null
}

/** A saved preliminary forecast (20261025000000_forecast_previews.sql): never official, never scored. */
export type ForecastPreviewRow = {
  id: string
  organization_id: string
  crop_id: string
  origin_year: number
  origin_week: number
  basis: 'lifecycle' | 'breaker_only'
  engine_version: string
  /** forecast_input_signature() when computed: compare with the current value to see if the data changed since. */
  input_signature: string
  preview: unknown
  created_at: string
  created_by: string | null
}

export type WeeklyHarvestActualRow = {
  id: number
  organization_id: string
  crop_id: string
  year: number
  week: number
  /** Null: the week was cleared. */
  actual_kg: number | null
  note: string | null
  entered_at: string
  entered_by: string | null
}

// ---- Server-side forecast locking (20261023000000_forecast_lock_jobs.sql) ----

export type ForecastLockJobRow = {
  id: number
  organization_id: string
  crop_id: string
  year: number
  week: number
  sampling_event_id: string
  status: 'pending' | 'waiting_for_sync' | 'running' | 'retry' | 'done' | 'superseded' | 'incomplete' | 'failed'
  attempts: number
  next_attempt_at: string
  lease_until: string | null
  last_error: string | null
  run_id: string | null
  run_kind: 'official' | 'late' | null
  created_at: string
  updated_at: string
}

export type LockReadiness = { state: 'ready' | 'waiting_for_sync' | 'incomplete' | 'superseded' | 'locked'; checked_in_db: number | null; checked_seen: number | null; detail: string | null }

// ---- Climate (20261027000000_climate_ingest.sql, 20261028000000_climate_review_and_monitoring.sql) ----
// Written only through functions (and the `climate` Edge Function); the app reads.

export type ClimateSourceRow = {
  id: string
  organization_id: string
  kind: 'ridder_synopta_block_summary'
  name: string
  time_zone: string
  created_at: string
  created_by: string | null
}

export type ClimateAgentKeyRow = {
  id: string
  organization_id: string
  source_id: string
  label: string
  key_prefix: string
  created_at: string
  created_by: string | null
  expires_at: string | null
  revoked_at: string | null
  revoked_by: string | null
  last_used_at: string | null
}

export type ClimateZoneRow = {
  id: string
  organization_id: string
  source_id: string
  /** Exactly as the climate computer labels the column ("Zone 8"); the identifier. */
  source_label: string
  zone_number: number | null
  display_name: string | null
  status: 'active' | 'retired'
  first_seen_hour: string | null
  last_seen_hour: string | null
  created_at: string
  updated_at: string
}

export type ClimateFileState = 'active' | 'conflict' | 'superseded' | 'none'

export type ClimateProblem = { code: string; message: string }

export type ClimateImportFileRow = {
  id: string
  organization_id: string
  source_id: string
  sha256: string
  /** bytea: '\\x' + hex. Select it only when needed (download, compare). */
  raw_bytes: string
  byte_size: number
  original_filename: string
  encoding: string | null
  channel: 'agent' | 'manual'
  agent_key_id: string | null
  uploaded_by: string | null
  agent_version: string | null
  received_at: string
  parser_version: string
  parse_status: 'parsed' | 'quarantined'
  problems: ClimateProblem[]
  warnings: ClimateProblem[]
  filename_local: string | null
  system_date_raw: string | null
  system_time_raw: string | null
  week_number_raw: string | null
  metadata: Record<string, unknown>
  hour_utc: string | null
  hour_local: string | null
  time_method: 'filename' | 'system' | 'review' | null
  date_order: 'MDY' | 'DMY' | 'either' | null
  clock_offset_minutes: number | null
  hour_state: ClimateFileState
  reviewed_at: string | null
  reviewed_by: string | null
  review_note: string | null
}

export type ClimateReadingRow = {
  id: number
  organization_id: string
  source_id: string
  file_id: string
  zone_id: string
  hour_utc: string
  row_label: string
  metric: string
  unit: string | null
  unit_raw: string | null
  raw_text: string
  value: number | null
  flags: string[]
}

export type ClimateImportAttemptRow = {
  id: number
  organization_id: string | null
  source_id: string | null
  file_id: string | null
  sha256: string | null
  filename: string | null
  channel: 'agent' | 'manual'
  agent_key_id: string | null
  uploaded_by: string | null
  outcome: 'created' | 'duplicate' | 'conflict' | 'quarantined'
  detail: Record<string, unknown>
  created_at: string
}

export type ClimateFileReviewRow = {
  id: number
  organization_id: string
  source_id: string
  file_id: string
  action: 'activate' | 'set_aside' | 'resolve_quarantine' | 'superseded_by_review'
  state_before: string
  state_after: string
  replaced_file_id: string | null
  hour_utc: string | null
  parser_version: string | null
  note: string
  reviewed_by: string
  reviewed_at: string
}

export type CropClimateZoneRow = {
  id: string
  organization_id: string
  crop_id: string
  zone_id: string
  valid_from: string
  /** Exclusive; null = open-ended. */
  valid_until: string | null
  area_share: number | null
  change_id: string
  reason: string | null
  recorded_at: string
  recorded_by: string | null
  superseded_at: string | null
  superseded_by: string | null
}

/** [epoch seconds, value, excluded (0/1), flags or area share]. */
export type ClimatePoint = [number, number | null, 0 | 1, string[] | number | null]
export type ClimateSeries = { zone_id: string; metric: string; unit: string | null; source_label?: string; points: ClimatePoint[] }
/** [date, hours with a usable value, mean, min, max, excluded count]. */
export type ClimateDailyDay = [string, number, number | null, number | null, number | null, number]
export type ClimateDailySeries = { zone_id: string; metric: string; days: ClimateDailyDay[] }
export type ClimateImportStatus = {
  last_success: { received_at: string; filename: string; channel: 'agent' | 'manual'; hour_utc: string; hour_local: string } | null
  latest_hour: string | null
  first_hour: string | null
  files: Partial<Record<ClimateFileState, number>> | null
  attempts_7d: Partial<Record<ClimateImportAttemptRow['outcome'], number>> | null
  to_review: number
  missing_7d: number
  agent_last_used: string | null
}

// ---- Breaker photos (20261019000000_breaker_photos.sql) ----
// Append-only. Images are in the private Storage bucket 'node-photos'.

export type PhotoSide = 'front' | 'back'

export type NodePhotoRow = {
  id: string
  organization_id: string
  crop_id: string
  plant_node_id: string
  node_observation_id: string
  side: PhotoSide
  /** Where the node was, and the crop's ripe colour, at capture (filled in by the database). */
  measurement_stem_id: string
  measurement_row_id: string
  node_number: number
  node_label: string | null
  is_side_shoot: boolean
  target_colour: CropColor
  year: number
  week_number: number
  storage_path: string
  /** A small JPEG made on the phone (null when the phone couldn't make one). */
  preview_path: string | null
  content_type: string
  bytes: number
  width: number | null
  height: number | null
  sha256: string
  taken_at: string
  recorded_at: string
  capture_meta: Record<string, unknown>
  /** A replacement photo: the earlier photo of the same Breaker record and side it replaces (kept). */
  replaces_photo_id: string | null
  created_by: string | null
}

export type PhotoColourAnalysisRow = {
  id: string
  organization_id: string
  crop_id: string
  node_observation_id: string
  front_photo_id: string | null
  back_photo_id: string | null
  kind: 'automatic' | 'manual' | 'correction'
  method: string
  model_version: string
  target_colour: CropColor
  front_percent: number | null
  back_percent: number | null
  combined_percent: number
  confidence: number | null
  details: unknown
  supersedes_id: string | null
  note: string | null
  created_at: string
  created_by: string | null
}

export type PhotoPairCorrectionRow = {
  id: string
  organization_id: string
  crop_id: string
  node_observation_id: string
  kind: 'reassign_node' | 'unusable' | 'duplicate' | 'restore'
  corrected_node_id: string | null
  /** kind 'duplicate': the Breaker record of the same node and week that is kept. */
  duplicate_of_observation_id: string | null
  note: string | null
  created_at: string
  created_by: string | null
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
        Insert: Omit<CropRow, 'id' | 'created_by' | 'created_at' | 'updated_at' | 'case_weight_kg'> & { case_weight_kg?: number | null }
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
      node_photos: {
        Row: NodePhotoRow
        Insert: Pick<NodePhotoRow, 'id' | 'organization_id' | 'crop_id' | 'plant_node_id' | 'node_observation_id' | 'side' | 'storage_path' | 'content_type' | 'bytes' | 'sha256' | 'taken_at'> & {
          preview_path?: string | null
          width?: number | null
          height?: number | null
          capture_meta?: Record<string, unknown>
          replaces_photo_id?: string | null
        }
        Update: never
        Relationships: [
          {
            foreignKeyName: 'node_photos_node_observation_id_fkey'
            columns: ['node_observation_id']
            isOneToOne: false
            referencedRelation: 'node_observations'
            referencedColumns: ['id']
          },
        ]
      }
      photo_colour_analyses: {
        Row: PhotoColourAnalysisRow
        Insert: Pick<PhotoColourAnalysisRow, 'organization_id' | 'crop_id' | 'node_observation_id' | 'kind' | 'method' | 'model_version' | 'target_colour' | 'combined_percent'> &
          Partial<Pick<PhotoColourAnalysisRow, 'id' | 'front_photo_id' | 'back_photo_id' | 'front_percent' | 'back_percent' | 'confidence' | 'supersedes_id' | 'note'>>
        Update: never
        Relationships: []
      }
      photo_pair_corrections: {
        Row: PhotoPairCorrectionRow
        Insert: Pick<PhotoPairCorrectionRow, 'organization_id' | 'crop_id' | 'node_observation_id' | 'kind'> & Partial<Pick<PhotoPairCorrectionRow, 'corrected_node_id' | 'duplicate_of_observation_id' | 'note'>>
        Update: never
        Relationships: []
      }
      mobile_status_options: {
        Row: MobileStatusOptionRow
        Insert: Pick<MobileStatusOptionRow, 'organization_id' | 'status' | 'enabled'>
        Update: Pick<MobileStatusOptionRow, 'enabled'>
        Relationships: []
      }
      stem_visits: {
        Row: StemVisitRow
        Insert: Pick<StemVisitRow, 'id' | 'organization_id' | 'crop_id' | 'measurement_stem_id' | 'year' | 'week_number' | 'checked' | 'observed_at'>
        Update: never
        Relationships: []
      }
      harvestable_marks: {
        Row: HarvestableMarkRow
        Insert: Pick<HarvestableMarkRow, 'id' | 'organization_id' | 'crop_id' | 'plant_node_id' | 'year' | 'week_number' | 'harvestable' | 'observed_at'>
        Update: never
        Relationships: []
      }
      sampling_week_events: {
        Row: SamplingWeekEventRow
        Insert: Pick<SamplingWeekEventRow, 'id' | 'organization_id' | 'crop_id' | 'year' | 'week_number' | 'event' | 'observed_at'> & {
          note?: string | null
          stems_checked_seen?: number | null
          stems_expected_seen?: number | null
        }
        Update: never
        Relationships: []
      }
      forecast_runs: {
        Row: ForecastRunRow
        Insert: never
        Update: never
        Relationships: []
      }
      forecast_run_weeks: {
        Row: ForecastRunWeekRow
        Insert: never
        Update: never
        Relationships: []
      }
      forecast_lock_jobs: {
        Row: ForecastLockJobRow
        Insert: never
        Update: never
        Relationships: []
      }
      weekly_harvest_afw_log: {
        Row: WeeklyHarvestAfwLogRow
        Insert: never
        Update: never
        Relationships: []
      }
      forecast_basis_settings: {
        Row: ForecastBasisSettingRow
        Insert: Pick<ForecastBasisSettingRow, 'organization_id' | 'crop_id' | 'from_year' | 'from_week' | 'basis'> & {
          harvest_ready_share?: number | null
          note?: string | null
        }
        Update: never
        Relationships: []
      }
      forecast_previews: {
        Row: ForecastPreviewRow
        Insert: Pick<ForecastPreviewRow, 'organization_id' | 'crop_id' | 'origin_year' | 'origin_week' | 'basis' | 'engine_version' | 'input_signature' | 'preview'>
        Update: never
        Relationships: []
      }
      weekly_harvest_actuals: {
        Row: WeeklyHarvestActualRow
        Insert: Pick<WeeklyHarvestActualRow, 'organization_id' | 'crop_id' | 'year' | 'week' | 'actual_kg'> & { note?: string | null }
        Update: never
        Relationships: []
      }
      data_quality_reviews: {
        Row: DataQualityReviewRow
        Insert: Pick<DataQualityReviewRow, 'organization_id' | 'crop_id' | 'flag_key' | 'rule_id' | 'decision'> & {
          id?: string
          note?: string | null
          flag_snapshot?: unknown
        }
        Update: never
        Relationships: []
      }
      climate_sources: { Row: ClimateSourceRow; Insert: never; Update: never; Relationships: [] }
      climate_agent_keys: { Row: ClimateAgentKeyRow; Insert: never; Update: never; Relationships: [] }
      climate_zones: { Row: ClimateZoneRow; Insert: never; Update: never; Relationships: [] }
      climate_import_files: { Row: ClimateImportFileRow; Insert: never; Update: never; Relationships: [] }
      climate_readings: { Row: ClimateReadingRow; Insert: never; Update: never; Relationships: [] }
      climate_import_attempts: { Row: ClimateImportAttemptRow; Insert: never; Update: never; Relationships: [] }
      climate_file_reviews: { Row: ClimateFileReviewRow; Insert: never; Update: never; Relationships: [] }
      crop_climate_zones: { Row: CropClimateZoneRow; Insert: never; Update: never; Relationships: [] }
    }
    Views: {
      climate_readings_active: { Row: ClimateReadingRow; Relationships: [] }
      node_latest_statuses: {
        Row: Omit<NodeObservationRow, 'created_by'> & { measurement_stem_id: string; measurement_row_id: string }
        Relationships: []
      }
    }
    Functions: {
      climate_create_source: { Args: { p_organization_id: string; p_name: string }; Returns: ClimateSourceRow }
      climate_create_agent_key: { Args: { p_source_id: string; p_label: string; p_expires_at?: string | null }; Returns: { id: string; key_prefix: string; key: string } }
      climate_revoke_agent_key: { Args: { p_key_id: string }; Returns: undefined }
      climate_set_zone_display_name: { Args: { p_zone_id: string; p_display_name: string | null }; Returns: undefined }
      climate_review_file: { Args: { p_file_id: string; p_action: 'activate' | 'set_aside'; p_note: string }; Returns: { file_id: string; state: string; replaced_file_id?: string | null } }
      climate_series: { Args: { p_source_id: string; p_zone_ids: string[]; p_metrics: string[]; p_from: string; p_to: string }; Returns: ClimateSeries[] }
      climate_daily: { Args: { p_source_id: string; p_zone_ids: string[]; p_metrics: string[]; p_from: string; p_to: string }; Returns: ClimateDailySeries[] }
      climate_daily_totals: {
        Args: { p_source_id: string; p_from: string; p_to: string; p_zone_ids?: string[] | null }
        Returns: {
          local_date: string
          metric: 'radiation_sum' | 'drain_percentage' | 'irrigation_cumulative'
          zone_id: string
          final_hour: number
          final_value: number | null
          status: 'final' | 'running' | 'incomplete' | 'no_data'
          running_value: number | null
          running_hour: number | null
          restart_hour: number | null
          problems: string[]
        }[]
      }
      climate_missing_hours: { Args: { p_source_id: string; p_from: string; p_to: string }; Returns: [string, string, number][] }
      climate_import_status: { Args: { p_source_id: string }; Returns: ClimateImportStatus }
      set_crop_climate_zones: { Args: { p_crop_id: string; p_from: string; p_zones: { zone_id: string; area_share?: number | null }[]; p_reason?: string | null }; Returns: string }
      crop_climate_series: { Args: { p_crop_id: string; p_metrics: string[]; p_from: string; p_to: string; p_as_of?: string }; Returns: ClimateSeries[] }
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
      weekly_harvestable: {
        Args: { p_crop_id: string; p_year: number }
        Returns: WeeklyHarvestableRow[]
      }
      sampling_weeks: {
        Args: { p_crop_id: string; p_year: number; p_as_of?: string }
        Returns: SamplingWeekRow[]
      }
      crop_quality_flags: {
        Args: { p_crop_id: string; p_as_of?: string }
        Returns: QualityFlagRow[]
      }
      forecast_input_signature: {
        Args: { p_crop_id: string; p_year: number; p_week: number }
        Returns: string
      }
      forecast_lock_readiness: {
        Args: { p_sampling_event_id: string }
        Returns: LockReadiness[]
      }
      claim_forecast_lock_job: {
        Args: Record<string, never>
        Returns: ForecastLockJobRow[]
      }
      finish_forecast_lock_job: {
        Args: { p_job_id: number; p_run_id: string }
        Returns: undefined
      }
      fail_forecast_lock_job: {
        Args: { p_job_id: number; p_error: string }
        Returns: undefined
      }
      lock_forecast_run: {
        Args: LockForecastArgs
        Returns: { run_id: string; kind: 'official' | 'late'; stored_now: boolean; locked_at: string }[]
      }
    }
    Enums: Record<string, never>
    CompositeTypes: Record<string, never>
  }
}
