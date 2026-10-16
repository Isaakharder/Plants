// Inputs and outputs of the harvest forecast engine.
//
// The engine is pure: it receives the raw records (as stored) and returns a
// forecast. The same code runs in backtests (fed a database export) and,
// later, in the scheduled job that locks official forecasts. Every input is
// filtered to what had been recorded by the forecast's cutoff inside the
// engine, so a caller can't accidentally leak later data.

export type NodeStatus = 'Aborted' | 'Pruned' | 'Flower' | 'SetFruit' | 'MatureGreen' | 'BreakerFruit' | 'Harvested'

export type EngineCrop = {
  id: string
  /** Picking stems in the whole crop. */
  pickingStems: number
  areaM2: number
}

export type EngineStem = { id: string; rowId: string; isActive: boolean }

export type EngineNode = {
  id: string
  stemId: string
  isSideShoot: boolean
  isActive: boolean
  /** When the node was added (visit evidence for its stem that week). */
  createdAt: string
}

export type EngineObservation = {
  id: string
  nodeId: string
  year: number
  week: number
  status: NodeStatus
  observedAt: string
  recordedAt: string
}

export type EngineGrowth = { stemId: string; year: number; week: number; observedAt: string }

export type EngineStemVisit = { stemId: string; year: number; week: number; checked: boolean; observedAt: string; recordedAt: string }

/** A crop's sampling marked complete / reopened for a week. */
export type EngineSamplingEvent = { year: number; week: number; event: 'completed' | 'reopened'; observedAt: string; recordedAt: string }

/** Entered AFW (grams per pepper harvested that week). */
export type EngineAfw = { year: number; week: number; afwG: number }

/** A data-quality flag as it stood at the cutoff (crop_quality_flags(crop, cutoff)). */
export type EngineFlag = {
  flagKey: string
  ruleId: string
  scope: 'week' | 'stem_week' | 'node'
  yw: number
  stemId: string | null
  nodeId: string | null
  /** Unreviewed flags are null: the data is used as recorded. */
  reviewDecision: 'recording_error' | 'legitimate' | null
  /** Stems named in the evidence of a week-level coverage flag (incomplete_visit). */
  unvisitedStemIds?: string[]
}

/**
 * What a variety's forecast rests on from a week on (forecast_basis_settings):
 *   lifecycle     the eight-week stage forecast (SetFruit → … → Harvested recorded)
 *   breaker_only  only Breakers are recorded (Friday walkthrough): next week's
 *                 harvest from that Friday's Breakers × the harvest-ready share
 */
export type ForecastBasis = 'lifecycle' | 'breaker_only'

export type EngineBasisSetting = {
  fromYear: number
  fromWeek: number
  basis: ForecastBasis
  /** Breakers only: share of a Friday's Breakers harvested the following week. */
  harvestReadyShare: number | null
  createdAt: string
}

export type EngineInput = {
  crop: EngineCrop
  stems: EngineStem[]
  nodes: EngineNode[]
  observations: EngineObservation[]
  growth: EngineGrowth[]
  stemVisits: EngineStemVisit[]
  /** Sampling completions; with explicit stem checks they make a week's records "verified". Optional for older callers. */
  samplingEvents?: EngineSamplingEvent[]
  afw: EngineAfw[]
  flags: EngineFlag[]
  /** Forecast basis settings (all rows; the engine picks the one in effect). Optional for older callers: lifecycle. */
  basisSettings?: EngineBasisSetting[]
}

/** Identifies the engine's rules and defaults in every stored forecast. Change it with any change to how forecasts are computed. */
export const ENGINE_VERSION = 'stage-8w-2026.10.2'

export type AfwMethod = 'last' | 'mean3' | 'trend6'

/** Weeks every forecast covers. Fruit can take 6–8+ weeks from set to harvest. */
export const FORECAST_WEEKS = 8
/** The first weeks: the marketer's planning window (its total excludes the outlook weeks). */
export const MARKETING_WEEKS = 5

export type ModelParams = {
  /** Weeks for a transition's weight to halve, by stage (Infinity = no recency weighting). */
  halfLifeWeeks: { SetFruit: number; MatureGreen: number; BreakerFruit: number }
  /** Pseudo-observations pulling each age cell toward its stage's pooled probabilities. */
  shrinkage: number
  /** Estimate side-shoot fruit separately (shrunk toward all fruit). */
  splitSideShoots: boolean
  /**
   * Fruit-load bands for set fruit: 0 = off, n = split SetFruit transitions
   * into n bands of the stem's live fruit count (quantiles of the training
   * data as of the origin), each shrunk toward all set fruit. Young pepper
   * fruit abort more on heavily loaded plants.
   */
  loadBands: number
  /** Recent weeks averaged for the rate of new sets (fruit not on the plant yet at the cutoff). */
  setRateWeeks: number
  afwMethod: AfwMethod
  /** Use an AFW the grower entered for a target week (Grower AFW) instead of the model's estimate. */
  growerAfw: boolean
  /**
   * Treat these rules' flags as confirmed recording errors even if nobody has
   * reviewed them (a backtest scenario, never the live default).
   */
  assumeConfirmed: string[]
  /**
   * Records from weeks without explicit stem checks and a completed sampling
   * week (legacy, e.g. Mathieu 2026, which has known node-identity mistakes)
   * are only a prior: once verified records exist, each cell is fitted on the
   * verified records, pulled toward the legacy estimate with this many
   * pseudo-observations. With no verified records the legacy fit is used.
   */
  legacyPriorStrength: number
}

export const DEFAULT_PARAMS: ModelParams = {
  halfLifeWeeks: { SetFruit: 6, MatureGreen: 8, BreakerFruit: 12 },
  shrinkage: 4,
  splitSideShoots: false,
  loadBands: 3,
  setRateWeeks: 4,
  afwMethod: 'trend6',
  growerAfw: true,
  assumeConfirmed: [],
  legacyPriorStrength: 10,
}

export type ForecastOptions = {
  /** The last week whose sampling the forecast uses (the forecast covers origin + 1 … origin + horizon). */
  originIndex: number
  /** Only records stored by this instant are used. */
  cutoff: string
  /** Only records observed by this instant are used (an official forecast: its sampling completion). Defaults to cutoff. */
  observedCutoff?: string
  /** Horizons already validated by live accuracy (for the confidence assessment). */
  validatedHorizons?: number[]
  horizon?: number
  params?: Partial<ModelParams>
}

export type ForecastWeek = {
  targetIndex: number
  targetYw: number
  horizon: number
  /** Weeks 1–5: the marketing window; 6–8: the longer-range outlook. */
  window: 'marketing' | 'outlook'
  /**
   * False when the data can't support this week (Breakers only beyond next
   * week, or a stage without enough history): its numbers are 0 and its kg
   * null, and they must not be shown or stored as a forecast.
   */
  available: boolean
  /** Why the week isn't available. */
  unavailableReason: string | null
  /** Expected peppers first recorded Harvested in the target week on the sampled stems. */
  sampleFruit: number
  /** Variance of sampleFruit (fruit-level randomness only). */
  sampleVariance: number
  /** Where the expected harvest comes from: fruit at each stage at the origin, catch-up from unvisited stems, fruit not set yet. */
  components: { breaker: number; matureGreen: number; setFruit: number; catchUp: number; newSets: number }
  /** Fruit on the plant at the origin expected to abort / be pruned in this week (sample). */
  expectedAborted: number
  expectedPruned: number
  /** sampleFruit × picking stems ÷ sampled stems. */
  cropFruit: number
  afwG: number | null
  afwSource: string | null
  /** 'grower': entered by the grower for this week; 'model': estimated. */
  afwKind: 'grower' | 'model' | null
  kg: number | null
}

export type ForecastResult = {
  originIndex: number
  originYw: number
  cutoff: string
  horizon: number
  sampleStems: number
  /** The sampled stems (sorted ids): the population the forecast and its scoring cover. */
  sampleStemIds: string[]
  scale: number
  inventory: { setFruit: number; matureGreen: number; breaker: number; unvisitedAtOrigin: number }
  /**
   * Expected fate of the fruit on the plant at the origin over the forecast
   * weeks (sample counts): harvested within them, aborted, pruned, or still on
   * the plant (unharvested) after the last week, by stage then.
   */
  inventoryFate: { harvested: number; aborted: number; pruned: number; stillOnPlant: { S: number; M: number; B: number }; horizon: number }
  /** Expected new sets per week on the sampled stems (recent average). */
  newSetsPerWeek: number
  training: { transitions: number; excludedStemWeeks: number; excludedNodes: number }
  weeks: ForecastWeek[]
  /** Weeks 1–5 only, for marketing (null numbers when any of them isn't available). */
  marketingTotal: { weeks: number; sampleFruit: number | null; cropFruit: number | null; kg: number | null }
  basis: ForecastBasis
  /** Where the basis came from: a setting (its start week), or none set. */
  basisSource: { kind: 'setting'; fromYear: number; fromWeek: number } | { kind: 'default' }
  /** Breakers only: the harvest-ready share used. */
  harvestReadyShare: number | null
  /** Breakers only: how the week's Breakers were counted. */
  breakers: BreakerBreakdown | null
  /** Stems checked or recorded at the origin ÷ stems in the sample (null when none). */
  coverage: { visited: number; expected: number; share: number | null }
  params: ModelParams
  engineVersion: string
  /** What the forecast rests on, for auditing. */
  dataSummary: DataSummary
  confidence: { level: 'experimental' | 'standard'; reasons: string[] }
}

export type DataSummary = {
  observedCutoff: string
  recordedCutoff: string
  /** One-week transitions the model learned from, by data tier. */
  training: { legacy: number; verified: number; verifiedShare: number }
  /** Records observed in weeks without explicit stem checks / completion. */
  legacyWeeks: number
  verifiedWeeks: number
  /** Flags treated as recording errors in this run (confirmed by a person, or assumed in a backtest). */
  flagsApplied: { flagKey: string; ruleId: string; decision: 'recording_error' | 'assumed' }[]
  /** Flags open at the cutoff: their data was used as recorded. */
  unreviewedFlags: number
  excludedStemWeeks: number
  excludedNodes: number
  inventory: { setFruit: number; matureGreen: number; breaker: number; unvisitedAtOrigin: number }
  loadBandCuts: number[] | null
  afwSource: string | null
}

export type BreakerBreakdown = {
  /** Distinct nodes recorded Breaker at the origin, on stems visited then (each pepper once). */
  total: number
  /** Recorded Breaker the previous week too (still on the plant). */
  carriedOver: number
  /** Not Breaker the previous week, on a stem checked the previous week. */
  new: number
  /** The stem wasn't checked the previous week (or this is the first sampled week): new or carried over unknown. */
  firstSeen: number
  /** Breakers of the previous week on stems visited both weeks, not recorded Breaker again: out of the inventory (not counted as harvested). */
  notRecordedAgain: number
  /** Breakers × (1 − share) × scale: may still be picked later; counted only if recorded again. */
  possibleLaterCrop: number
}
