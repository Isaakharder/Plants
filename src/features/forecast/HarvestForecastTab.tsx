import { useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Dialog } from '../../components/Dialog'
import { EmptyState, ErrorState, LoadingState } from '../../components/States'
import { useCrops } from '../crops/api'
import { sortCrops, type Crop } from '../crops/model'
import { useOrganization } from '../organization/OrganizationProvider'
import { useWorkflowFrom } from '../harvests/api'
import { ProjectionsTabs } from '../projections/ProjectionsTabs'
import wpd from '../projections/WeeklyPlantDataTab.module.css'
import {
  addBasisSetting,
  currentWeek,
  generatePreview,
  latestCompletion,
  lockForecast,
  lockReadiness,
  saveCaseWeight,
  useForecastRunWeeks,
  useLiveAccuracy,
  useLockJobs,
  useForecastRuns,
  useInvalidateForecasts,
  useSamplingYear,
  useSavedPreview,
  useProductionHistory,
  useBasisSettings,
  reviseOfficialForecast,
} from './api'
import { errorPct, errorWord, formatError, productionHistory, type ProductionHistory } from './productionHistory'
import { LOW_COVERAGE } from './engine/breaker'
import { basisAt } from './engine/basis'
import { DEFAULT_HARVEST_READY_SHARE } from './engine/forecast'
import { DEFAULT_BASIS } from './data'
import { latestOf, revisable, revisionDeadline } from './revisions'
import type { ForecastRunRow } from '../../lib/database.types'
import { ForecastSettings } from './ForecastSettings'
import { SETS_OUTLOOK_ENABLED } from './setsOutlookData'
import { SetsPotentialCard } from './SetsPotentialCard'
import { FORECAST_WEEKS } from './engine/types'
import { weekLabel, weekStartInstant, weekIndex } from './engine/weeks'
import {
  STATUS_LABEL,
  formatCount,
  readyShareAdjustable,
  statusExplanation,
  viewFromPreview,
  viewFromRun,
  withReadyShare,
  type ForecastView,
} from './forecastView'
import styles from './HarvestForecastTab.module.css'

const dateTime = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { timeZone: 'America/Toronto', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })

/**
 * Projections › Harvest Forecast: eight weeks of expected harvest from the
 * pepper-by-pepper model. Weeks 1–5 are the marketing window (their total is
 * the marketing figure); weeks 6–8 are the longer-range outlook. Shows the
 * locked official forecast of a sampling week, or a preview computed now.
 */
export function HarvestForecastTab() {
  const organization = useOrganization()
  const crops = useCrops(organization.id)
  const [params, setParams] = useSearchParams()
  const sorted = useMemo(() => sortCrops(crops.data ?? []), [crops.data])
  const crop = sorted.find((c) => c.id === params.get('crop')) ?? sorted[0]

  if (crops.isPending) return <LoadingState />
  if (crops.error) return <ErrorState error={crops.error} />
  if (!crop) return <EmptyState title="No varieties yet" description="Add a variety in Settings, then record plants with the mobile collector." />
  return <CropForecast key={crop.id} crop={crop} crops={sorted} onSelect={(id) => setParams({ crop: id }, { replace: true })} />
}

function CropForecast({ crop, crops, onSelect }: { crop: Crop; crops: Crop[]; onSelect: (id: string) => void }) {
  const now = currentWeek()
  const runs = useForecastRuns(crop.id)
  const sampling = useSamplingYear(crop.id, now.year)
  const invalidate = useInvalidateForecasts()
  const live = useLiveAccuracy(crop)
  const jobs = useLockJobs(crop.id)
  // Post-harvest inspections: official locking is paused from this week (yyyyww) on.
  const workflowFrom = useWorkflowFrom(crop.id).data ?? null
  const paused = (week: number) => workflowFrom !== null && now.year * 100 + week >= workflowFrom
  // Locked forecasts list: the version whose details are open (How it was made).
  const [detailsRunId, setDetailsRunId] = useState<string | null>(null)
  const [busy, setBusy] = useState<'preview' | 'lock' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showAudit, setShowAudit] = useState(false)
  const [showSettings, setShowSettings] = useState(false)

  // The current sampling week: the latest week with any visit (this week once sampling has begun). New forecasts,
  // the Ready % field and official revisions all refer to it; earlier weeks are in the history below.
  const samplingRows = sampling.data ?? []
  const latestSampled = [...samplingRows].reverse().find((r) => r.visited_stems > 0 && r.iso_week <= now.week)
  const originWeek = latestSampled?.iso_week ?? now.week
  const originRow = samplingRows.find((r) => r.iso_week === originWeek)
  const currentRow = samplingRows.find((r) => r.iso_week === now.week)

  // The current forecast (Ready %, What-if, revisions): the current sampling week's official forecast (its latest
  // version), else its saved preliminary forecast (with an outdated warning when its data changed).
  const stored = useSavedPreview(crop.id, now.year, originWeek)
  const lockedForOrigin = runs.data?.find((r) => r.origin_year === now.year && r.origin_week === originWeek)
  const showPreliminary = !lockedForOrigin && Boolean(stored.saved)
  const shownRun = lockedForOrigin
  const runWeeks = useForecastRunWeeks(shownRun?.id)
  // Forecast history: every target week, from the saved forecasts (Production Totals' rules, productionHistory.ts).
  const historyCrop = useMemo(() => ({ id: crop.id, name: crop.name, color: crop.color, plantingDate: crop.planting_date, pulloutDate: crop.pullout_date }), [crop])
  const history = useProductionHistory([crop.id], [now.year - 1, now.year, now.year + 1])
  const currentYw = now.year * 100 + now.week
  const historyPage = useMemo(
    () => (history.data ? productionHistory([historyCrop], history.data.snapshots, history.data.actuals, null, currentYw) : null),
    [history.data, historyCrop, currentYw],
  )
  const detailsRun = runs.data?.find((r) => r.id === detailsRunId)
  const detailsWeeks = useForecastRunWeeks(detailsRun?.id)
  const detailsView = useMemo(() => (detailsRun && detailsWeeks.data ? viewFromRun(detailsRun, detailsWeeks.data) : null), [detailsRun, detailsWeeks.data])
  const view: ForecastView | null = useMemo(() => {
    if (showPreliminary && stored.saved) return viewFromPreview(stored.saved.preview, crop.case_weight_kg === null ? null : Number(crop.case_weight_kg))
    if (shownRun && runWeeks.data) return viewFromRun(shownRun, runWeeks.data)
    return null
  }, [showPreliminary, stored.saved, shownRun, runWeeks.data, crop.case_weight_kg])

  // Ready % experiments: on any forecast with a next-week projection (locked or preliminary), kept in this page only.
  // The saved forecast is never changed; another forecast (variety, sampling week, snapshot) starts from its saved value.
  const viewKey = view ? `${crop.id}:${view.runId ?? 'preview'}:${view.at}` : ''
  const [trial, setTrial] = useState<{ key: string; share: number } | null>(null)
  // Bumped by "Reset to saved forecast" so the Ready % field shows the saved value again.
  const [resets, setResets] = useState(0)
  const resetTrial = () => {
    setTrial(null)
    setResets((n) => n + 1)
  }
  const adjustable = view !== null && readyShareAdjustable(view)
  const trialShare = adjustable && trial?.key === viewKey ? trial.share : null
  const shown = view && trialShare !== null ? withReadyShare(view, trialShare) : view
  const experimenting = trialShare !== null && view !== null && Math.abs(trialShare - (view.harvestReadyShare ?? 0)) > 1e-9

  // Ready % of the sampling week a forecast is generated from: chosen for that week (Forecast settings history), else 100%.
  // It never carries over from earlier weeks (engine/basis.ts); Generate uses what is typed here.
  const basisSettings = useBasisSettings(crop.id)
  const originInEffect = basisAt(
    (basisSettings.data ?? []).map((r) => ({ fromYear: r.from_year, fromWeek: r.from_week, basis: r.basis, harvestReadyShare: r.harvest_ready_share, createdAt: r.created_at })),
    weekIndex(now.year, originWeek),
    Date.now(),
    DEFAULT_BASIS,
  )
  const weekShare = originInEffect.harvestReadyShare ?? DEFAULT_HARVEST_READY_SHARE
  // A locked week shows its official Ready % (latest version); it can be revised until the sampling week ends.
  const allRuns = runs.data ?? []
  const clock = new Date()
  const originRevisable = lockedForOrigin ? revisable(allRuns, lockedForOrigin, clock) : false
  const fieldShare = lockedForOrigin ? (lockedForOrigin.harvest_ready_share ?? weekShare) : weekShare
  const weekShareKey = `${crop.id}:${now.year}:${originWeek}:${lockedForOrigin?.id ?? 'open'}:${fieldShare}`
  const [readyDraft, setReadyDraft] = useState<{ key: string; text: string } | null>(null)
  const readyText = readyDraft?.key === weekShareKey ? readyDraft.text : String(Math.round(1000 * fieldShare) / 10)
  const readyParsed = Number(readyText.replace(',', '.'))
  const readyValid = readyText.trim() !== '' && Number.isFinite(readyParsed) && readyParsed >= 5 && readyParsed <= 100
  const readyChanged = readyValid && Math.abs(readyParsed / 100 - fieldShare) > 1e-9
  const showWeekReady = basisSettings.isSuccess && (lockedForOrigin ? lockedForOrigin.basis === 'breaker_only' : originInEffect.basis === 'breaker_only')

  // A revised official forecast is published only after confirming it (never from the What-if alone).
  const [revising, setRevising] = useState<{ run: ForecastRunRow; percent: number } | null>(null)
  const shownRevisable = shownRun ? revisable(allRuns, shownRun, clock) : false

  const lockedThisWeek = runs.data?.find((r) => r.origin_year === now.year && r.origin_week === now.week)
  const firstTargetStarts = weekStartInstant(now.index + 1)

  async function runPreview() {
    if (lockedForOrigin && originRevisable && readyChanged) {
      setRevising({ run: latestOf(allRuns, lockedForOrigin), percent: Math.round(readyParsed * 10) / 10 })
      return
    }
    setBusy('preview')
    setError(null)
    try {
      // A Ready % typed for this sampling week is saved for that week only, then used by the forecast.
      if (showWeekReady && !lockedForOrigin) {
        if (!readyValid) throw new Error('Ready % must be between 5 and 100.')
        if (Math.abs(readyParsed / 100 - weekShare) > 1e-9) {
          await addBasisSetting({
            organizationId: crop.organization_id,
            cropId: crop.id,
            fromYear: now.year,
            fromWeek: originWeek,
            basis: 'breaker_only',
            share: Math.round(readyParsed * 10) / 1000,
            note: `Ready % for W${originWeek} set to ${Math.round(readyParsed * 10) / 10}% before generating`,
          })
          await basisSettings.refetch()
        }
      }
      // Saved for this variety and week: it stays across navigation, refreshes and sessions.
      await generatePreview(crop, now.year, originWeek, live.data?.validatedByBasis)
      await invalidate()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  /**
   * Only on request ("Save … and regenerate", preliminary forecasts): the tried
   * Ready % becomes the variety's setting from the shown sampling week on (a new
   * entry in the settings history), and a new preliminary version is generated
   * with it. Locked forecasts are never touched.
   */
  async function saveReadyShare(percent: number, originYear: number, originWeek: number) {
    setBusy('preview')
    setError(null)
    try {
      await addBasisSetting({
        organizationId: crop.organization_id,
        cropId: crop.id,
        fromYear: originYear,
        fromWeek: originWeek,
        basis: 'breaker_only',
        share: percent / 100,
        note: `Ready % set to ${percent}% in the forecast table`,
      })
      await generatePreview(crop, originYear, originWeek, live.data?.validatedByBasis)
      await invalidate()
      resetTrial()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  async function lockNow(week: number) {
    setBusy('lock')
    setError(null)
    try {
      const completion = await latestCompletion(crop.id, now.year, week)
      if (!completion) throw new Error(`W${week} sampling isn’t marked complete. Complete it in the collector first.`)
      // Never lock before the completion's stem checks have all reached the server.
      const ready = await lockReadiness(completion.id)
      if (ready?.state === 'waiting_for_sync') throw new Error(`${ready.detail} Wait until the phone has synced, then try again.`)
      await lockForecast(crop, completion)
      await invalidate()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  // Completed weeks without a locked forecast that can be locked: every sampled stem checked (the server enforces it too).
  const completedUnlocked = samplingRows.filter(
    (r) =>
      r.state === 'complete' &&
      r.checked_stems >= r.expected_stems &&
      !paused(r.iso_week) &&
      !runs.data?.some((run) => run.origin_year === now.year && run.origin_week === r.iso_week),
  )

  return (
    <section className={wpd.section} aria-label="Harvest Forecast">
      {/* One row: tabs and actions on the left, the forecast's fields on the right (they wrap below on narrow screens). */}
      <div className={styles.tbBar}>
        <div className={styles.tbLeft}>
          <ProjectionsTabs />
          <div className={styles.tbButtons}>
          <button type="button" className={`button button-secondary ${styles.tbButton}`} onClick={() => setShowSettings(true)} aria-haspopup="dialog">
            Forecast settings
          </button>
          <button type="button" className={`button button-secondary ${styles.tbButton}`} onClick={() => setShowAudit(true)} disabled={!view} aria-haspopup="dialog">
            How it was made
          </button>
          <button type="button" className={`button button-primary ${styles.tbButton}`} onClick={() => void runPreview()} disabled={busy !== null}>
            {busy === 'preview' ? 'Generating…' : 'Generate forecast'}
          </button>
          </div>
        </div>
        <div className={styles.tbFields}>
          <label className={`${styles.tbField} ${styles.tbVariety}`}>
            <select className={`input ${styles.tbControl}`} value={crop.id} onChange={(e) => onSelect(e.target.value)} aria-label="Variety" title="Variety">
              {crops.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          {showWeekReady && (
            <label className={`${styles.tbField} ${styles.tbNumber}`}>
              <span className={styles.tbLabel}>Ready % W{originWeek}</span>
              <input
                className={`input ${styles.tbControl}`}
                aria-label={`Ready % for the W${originWeek} sampling`}
                inputMode="decimal"
                value={readyText}
                aria-invalid={!readyValid}
                disabled={(Boolean(lockedForOrigin) && !originRevisable) || busy !== null}
                onChange={(e) => setReadyDraft({ key: weekShareKey, text: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter' || !readyValid) return
                  // Otherwise the same keypress lands on the confirmation dialog's first button and closes it.
                  e.preventDefault()
                  void runPreview()
                }}
                title={
                  lockedForOrigin
                    ? originRevisable
                      ? `W${originWeek}’s official Ready %. You can revise it until the sampling week ends (${dateTime(lockedForOrigin.first_target_starts)}): type a value and press Enter or Generate forecast to publish a revised official forecast. The original version is kept.`
                      : `W${originWeek}’s official forecast is final (its sampling week has ended). Try other values in the table below (What-if).`
                    : `Share of W${originWeek}’s Breakers expected to be harvested the week after (5–100). Every sampling week starts at 100%; ${
                        originInEffect.harvestReadyShare !== null ? 'this one was chosen for this week' : 'nothing chosen for this week yet'
                      }. Generate forecast saves a changed value for this week only and uses it.`
                }
              />
            </label>
          )}
          {/* Re-mounts when the saved value changes, so the field shows it. */}
          <CaseWeight key={String(crop.case_weight_kg)} crop={crop} />
        </div>
      </div>

      {error && <div className={styles.error}>{error}</div>}

      {workflowFrom !== null && (
        <div className={styles.pending} role="status">
          {crop.name} uses post-harvest inspections from {Math.floor(workflowFrom / 100)}-W{String(workflowFrom % 100).padStart(2, '0')}. The Breakers-only
          method (and its {'harvest-ready'} share) was calibrated on Friday walkthroughs, so official forecasts aren’t locked for those weeks until it is reviewed.
          Previews still work for comparison; forecasts already locked are unchanged.
        </div>
      )}

      {/* Lock buttons stay in sight when a completed week can be locked. */}
      {completedUnlocked.length > 0 && (
        <div className={styles.pending}>
          {completedUnlocked.map((r) => (
            <button key={r.iso_week} type="button" className="button button-secondary" disabled={busy !== null} onClick={() => void lockNow(r.iso_week)}>
              {busy === 'lock' ? 'Locking…' : `Lock W${r.iso_week} forecast now`}
            </button>
          ))}
        </div>
      )}

      {SETS_OUTLOOK_ENABLED && !sampling.isPending && (
        <SetsPotentialCard
          crop={crop}
          originWeek={originWeek}
          year={now.year}
          currentWeek={now.week}
          next={shown?.weeks.find((w) => w.horizon === 1) ?? null}
          nextSource={shown ? `${STATUS_LABEL[shown.status]} · W${shown.originWeek}` : null}
        />
      )}
      {runs.isPending || sampling.isPending || stored.loading || history.isPending ? (
        <LoadingState />
      ) : runs.error || sampling.error || history.error ? (
        <ErrorState error={runs.error ?? sampling.error ?? history.error} />
      ) : !historyPage || historyPage.rows.length === 0 ? (
        <EmptyState
          title={`No forecast for ${crop.name} yet`}
          description={`The official forecast locks automatically when a week’s sampling is marked complete in the collector. Generate forecast shows one now from the W${originWeek} sampling${originRow && originRow.state !== 'complete' ? ' (preliminary: not marked complete)' : ''}.`}
        />
      ) : (
        <>
          {experimenting && (
            <div className={styles.experimentBar} role="status">
              <span className={styles.experimentTag}>What-if</span>
              <span>
                Ready % {formatPercent(trialShare)} instead of the saved {formatPercent(view.harvestReadyShare)}: next week’s peppers, kg and cases are recalculated
                on this page only. The {view.source === 'locked'
                  ? `${STATUS_LABEL[view.status]} forecast${shownRun && shownRun.revision > 1 ? ` (version ${shownRun.revision}, revised` : ' (locked'}`
                  : 'preliminary forecast (saved'}{' '}
                {dateTime(view.at)}) is unchanged{view.source === 'locked' ? '' : ', and stays what Production Totals uses'}.
              </span>
              <span className={styles.experimentActions}>
                <button type="button" className="button button-secondary" onClick={resetTrial} disabled={busy !== null}>
                  Reset to saved forecast
                </button>
                {view.source === 'locked' && shownRevisable && shownRun && (
                  <button
                    type="button"
                    className="button button-primary"
                    disabled={busy !== null}
                    onClick={() => setRevising({ run: shownRun, percent: Math.round(1000 * trialShare!) / 10 })}
                    title={`Publishes a revised official W${view.originWeek} forecast with this Ready %. The current version is kept. Possible until ${dateTime(shownRun.first_target_starts)}.`}
                  >
                    Publish as revised official forecast…
                  </button>
                )}
                {showPreliminary && (
                  <button
                    type="button"
                    className="button button-link"
                    disabled={busy !== null}
                    onClick={() => void saveReadyShare(Math.round(1000 * trialShare!) / 10, view.originYear, view.originWeek)}
                    title={`Saves ${formatPercent(trialShare)} as ${crop.name}’s Ready % for the W${view.originWeek} sampling (Forecast settings history) and generates a new preliminary version`}
                  >
                    {busy === 'preview' ? 'Saving…' : `Save as ${crop.name}’s Ready % for W${view.originWeek} and regenerate`}
                  </button>
                )}
              </span>
            </div>
          )}
          <ForecastHistoryTable
            crop={crop}
            page={historyPage}
            current={
              view && shown
                ? {
                    view,
                    shown,
                    sourceId: view.source === 'locked' ? view.runId : (stored.saved?.id ?? null),
                    experimenting,
                    revision: shownRun ? { revision: shownRun.revision, revisableUntil: shownRevisable ? shownRun.first_target_starts : null } : null,
                    outdated: showPreliminary && stored.outdated,
                    onRegenerate: showPreliminary && stored.outdated ? () => void runPreview() : undefined,
                    regenerating: busy === 'preview',
                    readyShare: adjustable
                      ? {
                          saved: view.harvestReadyShare!,
                          value: trialShare ?? view.harvestReadyShare!,
                          fieldKey: `${viewKey}:${resets}`,
                          onChange: (share: number) => setTrial({ key: viewKey, share }),
                        }
                      : undefined,
                  }
                : null
            }
          />
        </>
      )}

      <details className={styles.details}>
        <summary>Forecast details</summary>
        <div className={styles.detailsBody}>
          <LockStatus
            week={now.week}
            current={currentRow}
            locked={lockedThisWeek}
            job={jobs.data?.find((j) => j.year === now.year && j.week === now.week) ?? null}
            firstTargetStarts={firstTargetStarts.toISOString()}
          />
          {shown && <ForecastExplanation view={shown} />}
        </div>
      </details>

      <Snapshots runs={runs.data ?? []} shown={view?.runId ?? null} onShow={(id) => setDetailsRunId(id)} />
      {detailsView && <AuditDialog open onClose={() => setDetailsRunId(null)} view={detailsView} />}
      {live.error && <div className={styles.error}>Couldn’t score forecasts: {live.error.message}</div>}
      {view && <AuditDialog open={showAudit} onClose={() => setShowAudit(false)} view={view} />}
      {revising && (
        <ReviseDialog
          run={revising.run}
          percent={revising.percent}
          view={view && view.runId === revising.run.id ? view : null}
          onClose={() => setRevising(null)}
          onPublished={async () => {
            setRevising(null)
            await invalidate()
            resetTrial()
            setReadyDraft(null)
          }}
        />
      )}
      {showSettings && <ForecastSettings crop={crop} open onClose={() => setShowSettings(false)} />}
    </section>
  )
}

const JOB_TEXT: Record<string, (job: { last_error: string | null; next_attempt_at: string }) => string> = {
  pending: () => 'locking on the server…',
  running: () => 'locking on the server…',
  waiting_for_sync: (j) => `waiting for the phone to sync before locking: ${j.last_error ?? ''}`,
  retry: (j) => `the server will retry at ${dateTime(j.next_attempt_at)} (${j.last_error ?? 'error'})`,
  failed: (j) => `the server couldn’t lock it: ${j.last_error ?? 'unknown error'}`,
  incomplete: (j) => `not locked: ${j.last_error ?? 'not every sampled stem was checked'} Check the remaining stems and mark sampling complete again.`,
  paused: (j) => `not locked: ${j.last_error ?? 'official forecasts are paused for the post-harvest workflow.'}`,
}

function LockStatus(props: {
  week: number
  current: { visited_stems: number; expected_stems: number; checked_stems: number; state: string; completed_at: string | null } | undefined
  locked: { kind: string; locked_at: string } | undefined
  job: { status: string; last_error: string | null; next_attempt_at: string } | null
  firstTargetStarts: string
}) {
  const { week, current, locked } = props
  return (
    <div className={styles.status}>
      <span>
        <strong>W{week} sampling:</strong>{' '}
        {current?.state === 'complete'
          ? `complete${current.completed_at ? ` (${dateTime(current.completed_at)})` : ''} · ${current.checked_stems} of ${current.expected_stems} stems checked`
          : current && current.visited_stems > 0
            ? `in progress · ${current.checked_stems} of ${current.expected_stems} stems checked`
            : 'not started'}
        {current && current.expected_stems > 0 && current.checked_stems < current.expected_stems && (
          <span className={styles.incompleteNote}> · locks automatically only when all {current.expected_stems} sampled stems are checked</span>
        )}
      </span>
      <span>
        <strong>Official forecast:</strong>{' '}
        {locked
          ? `${locked.kind === 'official' ? 'locked' : 'locked late'} ${dateTime(locked.locked_at)}`
          : props.job && props.job.status !== 'done' && props.job.status !== 'superseded'
            ? JOB_TEXT[props.job.status]?.(props.job) ?? props.job.status
            : `locked on the server when W${week} sampling is marked complete and synced (on time until ${dateTime(props.firstTargetStarts)})`}
      </span>
    </div>
  )
}

/** Target weeks in the history table: "W44", or "2026-W53" when the history spans New Year. */
const weekName = (yw: number, multiYear: boolean) => (multiYear ? `${Math.floor(yw / 100)}-W${String(yw % 100).padStart(2, '0')}` : `W${yw % 100}`)
const PHASE_LABEL = { completed: 'Completed', current: 'This week', future: 'Future' } as const
const FORECAST_MISSING_TEXT = {
  no_forecast: 'No forecast',
  saved_after_start: 'Saved too late',
  not_available: 'Not available',
  afw_needed: 'AFW needed',
} as const
const FORECAST_MISSING_TITLE = {
  no_forecast: 'No forecast was saved for this week',
  saved_after_start: 'Forecasts for this week were only saved after it began: not used as a prediction',
  not_available: 'The forecasts saved don’t cover this week (Breakers only: next week only)',
  afw_needed: 'Its forecast has no kg: enter an AFW in Weekly Plant Data',
} as const

type CurrentForecast = {
  /** The saved current forecast, and as shown (What-if applied). */
  view: ForecastView
  shown: ForecastView
  /** Its forecast_runs or forecast_previews id: the history row it stands for. */
  sourceId: string | null
  experimenting: boolean
  revision: { revision: number; revisableUntil: string | null } | null
  outdated: boolean
  onRegenerate?: () => void
  regenerating: boolean
  readyShare?: { saved: number; value: number; fieldKey: string; onChange: (share: number) => void }
}

/**
 * The forecast history of a variety, newest week first: per target week the
 * saved forecast that stands for it (productionHistory.ts, the rules
 * Production Totals uses: for a week that has begun, the newest official
 * version saved before it began, else the newest preliminary one; never one
 * saved later), the actual kg and the error. The current sampling week's
 * forecast keeps its Ready % field (What-if) in its row.
 */
function ForecastHistoryTable({ crop, page, current }: { crop: Crop; page: ProductionHistory; current: CurrentForecast | null }) {
  const multiYear = new Set(page.rows.map((r) => Math.floor(r.yw / 100))).size > 1
  const caseWeight = crop.case_weight_kg === null ? null : Number(crop.case_weight_kg)
  const v = current?.view
  const next = v?.weeks.find((w) => w.horizon === 1)
  const nextYw = next ? next.year * 100 + next.week : null
  const shownNext = current?.shown.weeks.find((w) => w.horizon === 1)
  const afwMissing = Boolean(v && v.weeks.some((w) => w.available && w.afwG === null))
  const incompleteWalk = Boolean(v && v.coverage.visited !== null && v.coverage.visited < v.coverage.expected)
  return (
    <div className={styles.card}>
      <div className={styles.cardHead}>
        <h2 className={styles.compactTitle}>
          Forecast history
          {v && (
            <>
              <span className={styles.titleSep}>·</span>
              <span className={v.status === 'official' || v.status === 'late' ? styles.statusOfficial : styles.statusPreliminary}>
                W{v.originWeek} {STATUS_LABEL[v.status]}
              </span>
              {current?.revision && current.revision.revision > 1 && <span className={styles.versionTag}> · version {current.revision.revision}</span>}
              {v.confidence.level === 'experimental' && (
                <>
                  <span className={styles.titleSep}>·</span>
                  <span className={styles.statusExperimental}>Experimental</span>
                </>
              )}
            </>
          )}
        </h2>
        {current?.revision && (
          <span className={styles.versionNote}>
            {current.revision.revisableUntil
              ? `W${v!.originWeek} Ready % revisable until ${dateTime(new Date(new Date(current.revision.revisableUntil).getTime() - 60_000).toISOString())}`
              : `W${v!.originWeek} official forecast is final`}
          </span>
        )}
      </div>
      {(current?.outdated || afwMissing || incompleteWalk) && (
        <ul className={styles.inlineNotes}>
          {current?.outdated && (
            <li>
              May be outdated: W{v!.originWeek} data or the forecast rules changed since it was generated.{' '}
              {current.onRegenerate && (
                <button type="button" className="button button-link" onClick={current.onRegenerate} disabled={current.regenerating}>
                  {current.regenerating ? 'Generating…' : 'Regenerate'}
                </button>
              )}
            </li>
          )}
          {afwMissing && <li>No AFW entered: kg and cases need an AFW (Weekly Plant Data).</li>}
          {incompleteWalk && (
            <li>
              Incomplete walkthrough: {v!.coverage.visited} of {v!.coverage.expected} stems
              {v!.coverage.share !== null && v!.coverage.share < LOW_COVERAGE ? ' (low coverage)' : ''}.
            </li>
          )}
        </ul>
      )}
      <div className={styles.historyWrap}>
        <table className={`${styles.table} ${styles.historyTable}`}>
          <thead>
            <tr>
              <th scope="col">Week</th>
              <th scope="col" title="The saved forecast that stands for the week: for a week that has begun, the newest official version saved before it began, else the newest preliminary one">
                Forecast
              </th>
              <th scope="col" title="Breakers only: the share of the sampling week’s Breakers expected to be harvested the week after">
                Ready %
              </th>
              <th scope="col" title="Peppers expected to be harvested on the whole crop">
                Peppers
              </th>
              <th scope="col" title="Average fruit weight, grams">
                AFW g
              </th>
              <th scope="col">Kg</th>
              <th scope="col">Cases</th>
              <th scope="col" title="Actual kg harvested that week, entered in Weekly Plant Data (the newest entry)">
                Actual kg
              </th>
              <th scope="col" title="(Forecast kg − actual kg) ÷ forecast kg. Positive = overestimated. Completed weeks only.">
                vs actual
              </th>
            </tr>
          </thead>
          <tbody>
            {page.rows.map((row) => {
              const part = row.all.parts[0]
              const f = part?.forecast ?? null
              // The current forecast's next week: its Ready % field, and What-if values while experimenting.
              const isCurrent = Boolean(current && f && f.sourceId === current.sourceId && row.yw === nextYw)
              const trial = isCurrent && current!.experimenting
              const kg = trial ? shownNext!.kg : (f?.kg ?? null)
              const cropFruit = trial ? shownNext!.cropFruit : (f?.cropFruit ?? null)
              const cases = trial ? shownNext!.cases : f?.cases !== undefined ? f.cases : kg !== null && caseWeight ? kg / caseWeight : null
              const err = part?.matched && !trial ? errorPct(f!.kg!, part.actualKg!) : null
              const sourceText = f
                ? `${f.kind === 'preliminary' ? 'Preliminary' : f.kind === 'official' ? 'Official' : 'Late'}${f.revision && f.revision > 1 ? ` v${f.revision}` : ''} · W${f.originYw % 100}`
                : null
              return (
                <tr key={row.yw} className={`${styles[`hist_${row.phase}`]} ${isCurrent ? styles.currentRow : ''}`}>
                  <th scope="row">
                    <span className={styles.weekName}>{weekName(row.yw, multiYear)}</span>
                    <span className={`${styles.phaseTag} ${styles[`phase_${row.phase}`]}`}>{PHASE_LABEL[row.phase]}</span>
                  </th>
                  <td className={styles.sourceCell} title={f ? `${sourceText}, saved ${dateTime(f.savedAt)}` : part?.forecastMissing ? FORECAST_MISSING_TITLE[part.forecastMissing] : 'Not in season'}>
                    {f ? sourceText : part?.forecastMissing ? <span className={styles.missingText}>{FORECAST_MISSING_TEXT[part.forecastMissing]}</span> : '·'}
                  </td>
                  <td className={styles.readyCell}>
                    {isCurrent && current!.readyShare ? (
                      <ReadyInput
                        key={current!.readyShare.fieldKey}
                        value={Math.round(1000 * current!.readyShare.value) / 10}
                        saved={Math.round(1000 * current!.readyShare.saved) / 10}
                        busy={current!.regenerating}
                        onChange={(percent) => current!.readyShare!.onChange(percent / 100)}
                      />
                    ) : f && f.basis === 'breaker_only' ? (
                      formatPercent(f.readyShare ?? null)
                    ) : (
                      <span className={styles.dash}>—</span>
                    )}
                  </td>
                  <td className={trial ? styles.experimental : undefined}>{formatCount(cropFruit)}</td>
                  <td>{f?.afwG != null ? f.afwG.toFixed(0) : '—'}</td>
                  <td className={`${styles.kg} ${trial ? styles.experimental : ''}`} title={trial ? 'What-if: recalculated with the Ready % you typed, not saved' : undefined}>
                    {kg === null ? <span className={styles.missingText}>{f ? 'AFW needed' : '—'}</span> : formatCount(kg)}
                  </td>
                  <td className={trial ? styles.experimental : undefined}>{formatCount(cases)}</td>
                  <td>
                    {row.phase === 'future' ? (
                      <span className={styles.dash}>—</span>
                    ) : part?.actualKg != null ? (
                      <>
                        {formatCount(part.actualKg)}
                        {row.phase === 'current' && <span className={styles.soFar}> so far</span>}
                      </>
                    ) : (
                      <span className={styles.missingText}>{row.phase === 'current' ? 'In progress' : 'Not entered'}</span>
                    )}
                  </td>
                  <td
                    className={err === null ? styles.dash : err > 0 ? styles.over : styles.under}
                    title={err === null ? (row.phase === 'completed' ? 'Needs both a forecast kg and an actual kg' : 'Compared once the week is over') : `${formatError(err)} (${errorWord(err)})`}
                  >
                    {formatError(err)}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <p className={styles.fate}>
        Newest week first. Each week shows the forecast that was saved for it: for a week that has begun, only one saved before it began (an official
        version over a preliminary one, the newest version); future weeks show the latest saved forecast. Forecasts are never recalculated here; every
        version stays in Locked forecasts below. Missing forecasts and actual kg are shown as missing, never as zero.
      </p>
    </div>
  )
}

const formatPercent = (share: number | null) => (share === null ? '—' : `${Math.round(1000 * share) / 10}%`)

/**
 * Ready % in the next-week row: typing a valid % (0–100) updates next week's
 * peppers, kg and cases at once, as an experiment (nothing is saved). Escape
 * goes back to the saved value.
 */
function ReadyInput({ value, saved, busy, onChange }: { value: number; saved: number; busy: boolean; onChange: (percent: number) => void }) {
  const [text, setText] = useState(String(value))
  const parsed = Number(text.replace(',', '.'))
  const valid = text.trim() !== '' && Number.isFinite(parsed) && parsed >= 0 && parsed <= 100
  const tried = valid && Math.abs(parsed - saved) > 1e-9
  return (
    <span className={styles.readyEdit}>
      <input
        className={`input ${styles.readyInput} ${tried ? styles.readyTried : ''}`}
        inputMode="decimal"
        value={text}
        aria-label="Harvest-ready %"
        aria-invalid={!valid}
        disabled={busy}
        title={`Share of this Friday’s Breakers expected to be harvested next week (0–100). Saved: ${saved}%. Try another value: kg and cases update here only. Escape: back to ${saved}%.`}
        onChange={(e) => {
          setText(e.target.value)
          const n = Number(e.target.value.replace(',', '.'))
          if (e.target.value.trim() !== '' && Number.isFinite(n) && n >= 0 && n <= 100) onChange(n)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            setText(String(saved))
            onChange(saved)
          }
        }}
      />
      {tried && <span className={styles.readySaved}>saved {saved}%</span>}
    </span>
  )
}

/** Forecast details (collapsible, below the table): status, basis, Breaker counts, assumptions. */
function ForecastExplanation({ view }: { view: ForecastView }) {
  const breakerOnly = view.basis === 'breaker_only'
  return (
    <>
      <p className={styles.subtitle}>
        {statusExplanation(view)} {view.source === 'locked' ? 'Locked' : 'Computed'} {dateTime(view.at)} · records observed to {dateTime(view.observedCutoff)} ·{' '}
        {view.sampleStems} sampled stems · {breakerOnly ? 'Next week from Breakers' : 'Full lifecycle · 8 weeks'}
      </p>
      {breakerOnly && view.breakers && <BreakerSummary view={view} />}
      {view.confidence.reasons.length > 0 && (
        <ul className={styles.reasons}>
          {view.confidence.reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      )}
      {view.fate && (
        <p className={styles.fate}>
          Of the fruit on the plants now (crop scale), the model expects {formatCount(view.fate.harvested)} to be harvested within {FORECAST_WEEKS} weeks,{' '}
          {formatCount(view.fate.aborted)} to abort, {formatCount(view.fate.pruned)} to be pruned and {formatCount(view.fate.stillOnPlant)} to still be on the plants
          after week {FORECAST_WEEKS}.
        </p>
      )}
    </>
  )
}


/** How a Breakers-only forecast counted this week's Breakers (each pepper once). */
function BreakerSummary({ view }: { view: ForecastView }) {
  const b = view.breakers!
  const share = view.harvestReadyShare ?? 0
  const prev = weekLabel(weekIndex(view.originYear, view.originWeek) - 1)
  return (
    <div className={styles.breakerSummary}>
      <p>
        <strong>{b.total.toLocaleString('en-US')} Breakers</strong> on {view.coverage.visited ?? view.sampleStems} of {view.coverage.expected} sampled stems in W{view.originWeek}:{' '}
        {b.new} new, {b.carriedOver} still Breaker from {prev}, {b.firstSeen} first seen (stem not checked in {prev}). Each pepper is counted once.
      </p>
      <p>
        Next week: {Math.round(100 * share)}% harvest-ready share (experimental) × {b.total} Breakers × {view.scale.toFixed(0)} (picking stems ÷ stems checked).{' '}
        About {formatCount(b.possibleLaterCrop)} peppers may be picked later; they count again only if recorded as Breaker next Friday.
      </p>
      {b.notRecordedAgain > 0 && (
        <p>
          {b.notRecordedAgain} of {prev}’s Breakers weren’t recorded again on stems checked this week: they are out of the Breaker inventory (not counted as
          harvested; actual kg is entered separately).
        </p>
      )}
    </div>
  )
}

const BASIS_NAME = { lifecycle: 'Full lifecycle', breaker_only: 'Breakers only' } as const

function Snapshots({
  runs,
  shown,
  onShow,
}: {
  runs: {
    id: string
    origin_year: number
    origin_week: number
    kind: string
    locked_at: string
    marketing_kg: number | null
    confidence: string
    basis: 'lifecycle' | 'breaker_only'
    revision: number
    harvest_ready_share: number | null
  }[]
  shown: string | null
  onShow: (id: string) => void
}) {
  if (runs.length === 0) return null
  return (
    <div className={styles.card}>
      <h2 className={styles.title}>Locked forecasts</h2>
      <p className={styles.subtitle}>
        Every forecast locked for this variety, and every revised version: none is ever changed or recalculated. A sampling week’s newest version counts
        (Production Totals, accuracy); earlier versions stay for auditing.
      </p>
      <table className={styles.table}>
        <thead>
          <tr>
            <th scope="col">Sampling week</th>
            <th scope="col">Version</th>
            <th scope="col">Status</th>
            <th scope="col">Basis</th>
            <th scope="col">Locked</th>
            <th scope="col">Weeks 1–5 kg</th>
            <th scope="col">Confidence</th>
            <th scope="col" />
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => {
            const latest = !runs.some((o) => o.origin_year === r.origin_year && o.origin_week === r.origin_week && o.revision > r.revision)
            const versions = runs.filter((o) => o.origin_year === r.origin_year && o.origin_week === r.origin_week).length
            return (
            <tr key={r.id} className={`${r.id === shown ? styles.shownRow : ''} ${latest ? '' : styles.replacedRow}`}>
              <th scope="row">
                W{r.origin_week} {r.origin_year}
              </th>
              <td title={latest ? 'The version that counts' : 'Replaced by a later version (kept for auditing)'}>
                {versions === 1 ? '—' : `${r.revision}${r.revision === 1 ? ' · original' : ''}${r.basis === 'breaker_only' ? ` · ${formatPercent(r.harvest_ready_share)}` : ''}${latest ? ' · counts' : ''}`}
              </td>
              <td>{r.kind === 'official' ? 'Official' : 'Late'}</td>
              <td>{BASIS_NAME[r.basis]}</td>
              <td>{dateTime(r.locked_at)}</td>
              <td className={styles.kg}>{r.basis === 'breaker_only' ? 'next week only' : formatCount(r.marketing_kg)}</td>
              <td>{r.confidence === 'experimental' ? 'Experimental' : 'Standard'}</td>
              <td>
                <button type="button" className="button button-link" onClick={() => onShow(r.id)} title="How this version was made: data, Breakers, Ready %, AFW">
                  Details
                </button>
              </td>
            </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

/**
 * Confirms publishing a revised official forecast: same data, another Ready %.
 * The server recomputes it from the locked numbers, keeps every earlier
 * version and refuses once the sampling week has ended.
 */
function ReviseDialog({
  run,
  percent,
  view,
  onClose,
  onPublished,
}: {
  run: ForecastRunRow
  percent: number
  /** The run as shown, to preview next week's kg (null: not on screen). */
  view: ForecastView | null
  onClose: () => void
  onPublished: (runId: string) => Promise<void>
}) {
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const before = view?.weeks.find((w) => w.horizon === 1)
  const after = view ? withReadyShare(view, percent / 100).weeks.find((w) => w.horizon === 1) : undefined
  const deadline = revisionDeadline(run)
  return (
    <Dialog open title={`Revise the official W${run.origin_week} forecast?`} onClose={onClose} className={styles.auditDialog}>
      <p className={styles.subtitle}>
        Ready % <strong>{percent}%</strong> instead of {formatPercent(run.harvest_ready_share)}
        {before && after && before.kg !== null && after.kg !== null && (
          <>
            : W{before.week} becomes <strong>{formatCount(after.kg)} kg</strong> ({formatCount(after.cases)} cases) instead of {formatCount(before.kg)} kg
          </>
        )}
        . This publishes version {run.revision + 1} of the official forecast, from the same W{run.origin_week} data. Version {run.revision}
        {run.revision === 1 ? ' (the original, locked ' + dateTime(run.locked_at) + ')' : ''} stays saved for auditing. The newest version is the one Production
        Totals and accuracy use. You can revise until the W{run.origin_week} sampling week ends ({dateTime(deadline.toISOString())}).
      </p>
      <label className="field">
        <span className="field-label">Why (optional)</span>
        <input className="input" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder="e.g. picking crew reports more ripe fruit" />
      </label>
      {error && <div className={styles.error}>{error}</div>}
      <div className={styles.dialogActions}>
        <button type="button" className="button button-secondary" onClick={onClose} disabled={saving}>
          Cancel
        </button>
        <button
          type="button"
          className="button button-primary"
          disabled={saving}
          onClick={async () => {
            setSaving(true)
            setError(null)
            try {
              const res = await reviseOfficialForecast(run.id, percent, note.trim() || null)
              if (!res) throw new Error('The revised forecast wasn’t saved')
              await onPublished(res.run_id)
            } catch (err) {
              setError(err instanceof Error ? err.message : String(err))
              setSaving(false)
            }
          }}
        >
          {saving ? 'Publishing…' : `Publish version ${run.revision + 1}`}
        </button>
      </div>
    </Dialog>
  )
}

function AuditDialog({ open, onClose, view }: { open: boolean; onClose: () => void; view: ForecastView }) {
  const d = view.dataSummary
  return (
    <Dialog open={open} title="How this forecast was made" onClose={onClose} className={styles.auditDialog}>
      <dl className={styles.audit}>
        <dt>Forecast</dt>
        <dd>
          {STATUS_LABEL[view.status]} from W{view.originWeek} {view.originYear} sampling · engine {view.engineVersion}
        </dd>
        <dt>Basis</dt>
        <dd>
          {view.basis === 'breaker_only'
            ? `Breakers only: next week = ${Math.round(100 * (view.harvestReadyShare ?? 0))}% of the week’s Breakers (experimental harvest-ready share). Later weeks aren’t available.`
            : 'Full lifecycle: the eight-week stage forecast.'}{' '}
          Stems checked or recorded: {view.coverage.visited ?? '—'} of {view.coverage.expected}.
        </dd>
        <dt>Data cutoffs</dt>
        <dd>
          Observed by {dateTime(view.observedCutoff)} and stored by {dateTime(view.recordedCutoff)}. Later records are not used.
        </dd>
        {d && (
          <>
            <dt>What the model learned from</dt>
            <dd>
              {d.training.legacy.toLocaleString()} fruit-weeks of unverified history (before explicit stem checks) and {d.training.verified.toLocaleString()} verified
              fruit-weeks ({Math.round(100 * d.training.verifiedShare)}% verified). Unverified history is used only until verified records replace it.
            </dd>
            <dt>Fruit on the plants</dt>
            <dd>
              {d.inventory.setFruit} SetFruit · {d.inventory.matureGreen} MatureGreen · {d.inventory.breaker} Breaker on {view.sampleStems} sampled stems
              {d.inventory.unvisitedAtOrigin > 0 && ` (${d.inventory.unvisitedAtOrigin} on stems not visited in the last sampling, carried forward)`}. Scale ×
              {view.scale.toFixed(0)} to the crop.
            </dd>
            <dt>Data-quality flags</dt>
            <dd>
              {d.flagsApplied.length === 0
                ? 'No flag was treated as a recording error.'
                : `${d.flagsApplied.length} confirmed recording error${d.flagsApplied.length === 1 ? '' : 's'} left out: ${d.flagsApplied.map((f) => f.flagKey).join(', ')}.`}{' '}
              {d.unreviewedFlags} unreviewed flag{d.unreviewedFlags === 1 ? '' : 's'}: their records were used as recorded.
            </dd>
            <dt>Fruit load</dt>
            <dd>{d.loadBandCuts ? `Set fruit split by live fruit per stem at ${d.loadBandCuts.join(' and ')} (bands from the training data).` : 'Not used (too little data).'}</dd>
            <dt>Fruit weight</dt>
            <dd>
              {d.afwSource ?? 'No AFW entered yet.'}
              {d.afwHistory === 'current' && ' (AFW change history wasn’t available, so current values were used.)'}
            </dd>
          </>
        )}
        <dt>Confidence</dt>
        <dd>
          <ul className={styles.reasons}>
            {view.confidence.reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </dd>
        <dt>Parameters</dt>
        <dd>
          <pre className={styles.params}>{JSON.stringify(view.model, null, 1)}</pre>
        </dd>
      </dl>
    </Dialog>
  )
}

function CaseWeight({ crop }: { crop: Crop }) {
  const saved = crop.case_weight_kg === null ? '' : String(Number(crop.case_weight_kg))
  const [text, setText] = useState(saved)
  const [state, setState] = useState<'idle' | 'saving' | 'error'>('idle')
  const invalidate = useInvalidateForecasts()
  const parsed = text.trim() === '' ? null : Number(text.replace(',', '.'))
  const valid = parsed === null || (Number.isFinite(parsed) && parsed > 0 && parsed <= 100)
  return (
    <label className={`${styles.tbField} ${styles.tbNumber}`}>
      <span className={styles.tbLabel}>Case kg</span>
      <input
        className={`input ${styles.tbControl}`}
        inputMode="decimal"
        value={text}
        placeholder="—"
        aria-invalid={!valid}
        onChange={(e) => setText(e.target.value)}
        onBlur={async () => {
          if (!valid || text === saved) return
          setState('saving')
          try {
            await saveCaseWeight(crop.id, parsed)
            await invalidate()
            setState('idle')
          } catch {
            setState('error')
          }
        }}
        title={state === 'error' ? 'Couldn’t save the case weight' : 'Kilograms per case (saved for this variety; blank hides cases)'}
      />
    </label>
  )
}

