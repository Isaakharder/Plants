import { Fragment, useMemo, useState } from 'react'
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
  runHistoricalReplay,
  saveCaseWeight,
  useForecastRunWeeks,
  useLiveAccuracy,
  useLockJobs,
  useForecastRuns,
  useInvalidateForecasts,
  useSamplingYear,
  useSavedPreview,
  useBasisSettings,
  type HistoricalReplay,
} from './api'
import { MAX_ABS_BIAS, MIN_COVERAGE, MIN_SETTLED, type ActualAccuracy, type ActualScoredRun, type LiveAccuracy, type ScoredRun, type WeekStatus } from './engine/live'
import { LOW_COVERAGE } from './engine/breaker'
import { basisAt } from './engine/basis'
import { DEFAULT_HARVEST_READY_SHARE } from './engine/forecast'
import { DEFAULT_BASIS } from './data'
import { ForecastSettings } from './ForecastSettings'
import { FORECAST_WEEKS, MARKETING_WEEKS } from './engine/types'
import { weekLabel, weekStartInstant, weekIndex } from './engine/weeks'
import {
  STATUS_LABEL,
  componentsTitle,
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
  const [selectedRun, setSelectedRun] = useState<string | null>(null)
  const [busy, setBusy] = useState<'preview' | 'lock' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showAudit, setShowAudit] = useState(false)
  const [showSettings, setShowSettings] = useState(false)

  // The sampling week a preview starts from: the latest week with any visit (this week once sampling has begun).
  const samplingRows = sampling.data ?? []
  const latestSampled = [...samplingRows].reverse().find((r) => r.visited_stems > 0 && r.iso_week <= now.week)
  // Previews start from the latest sampled week, or an earlier one picked (e.g. the last full lifecycle week).
  const sampledWeeks = samplingRows.filter((r) => r.visited_stems > 0 && r.iso_week <= now.week).map((r) => r.iso_week).reverse()
  const [pickedWeek, setPickedWeek] = useState<number | null>(null)
  const originWeek = pickedWeek ?? latestSampled?.iso_week ?? now.week
  const originRow = samplingRows.find((r) => r.iso_week === originWeek)
  const currentRow = samplingRows.find((r) => r.iso_week === now.week)

  // What is shown: a forecast picked in the list; else the official (locked) forecast of the sampling week;
  // else the saved preliminary forecast of that week (with an outdated warning when its data changed); else the latest locked one.
  const stored = useSavedPreview(crop.id, now.year, originWeek)
  const lockedForOrigin = runs.data?.find((r) => r.origin_year === now.year && r.origin_week === originWeek)
  const showPreliminary = !selectedRun && !lockedForOrigin && Boolean(stored.saved)
  const shownRunId = selectedRun ?? lockedForOrigin?.id ?? (showPreliminary ? null : runs.data?.[0]?.id ?? null)
  const shownRun = runs.data?.find((r) => r.id === shownRunId)
  const runWeeks = useForecastRunWeeks(shownRun?.id)
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
  const weekShareKey = `${crop.id}:${now.year}:${originWeek}:${weekShare}`
  const [readyDraft, setReadyDraft] = useState<{ key: string; text: string } | null>(null)
  const readyText = readyDraft?.key === weekShareKey ? readyDraft.text : String(Math.round(1000 * weekShare) / 10)
  const readyParsed = Number(readyText.replace(',', '.'))
  const readyValid = readyText.trim() !== '' && Number.isFinite(readyParsed) && readyParsed >= 5 && readyParsed <= 100
  const showWeekReady = basisSettings.isSuccess && originInEffect.basis === 'breaker_only'

  const lockedThisWeek = runs.data?.find((r) => r.origin_year === now.year && r.origin_week === now.week)
  const firstTargetStarts = weekStartInstant(now.index + 1)

  async function runPreview() {
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
      setSelectedRun(null)
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
      setSelectedRun(null)
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
      const res = await lockForecast(crop, completion)
      await invalidate()
      setSelectedRun(res?.run_id ?? null)
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
      <div className={`${wpd.toolbar} ${styles.forecastToolbar}`}>
        <ProjectionsTabs />
        <div className={`${wpd.selectors} ${styles.forecastSelectors}`}>
          <label className={`field ${wpd.control} ${styles.varietyField}`}>
            <span className="field-label">Variety</span>
            <select className="input" value={crop.id} onChange={(e) => onSelect(e.target.value)}>
              {crops.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          {sampledWeeks.length > 1 && (
            <label className={`field ${wpd.yearControl}`}>
              <span className="field-label">Preview from</span>
              <select
                className="input"
                value={originWeek}
                onChange={(e) => {
                  setPickedWeek(Number(e.target.value) === sampledWeeks[0] ? null : Number(e.target.value))
                  setSelectedRun(null)
                }}
                title="The sampling week a generated forecast starts from"
              >
                {sampledWeeks.map((w) => (
                  <option key={w} value={w}>
                    W{w}
                  </option>
                ))}
              </select>
            </label>
          )}
          {showWeekReady && (
            <label className={`field ${styles.weekReady}`}>
              <span className="field-label">Ready % (W{originWeek})</span>
              <input
                className="input"
                inputMode="decimal"
                value={lockedForOrigin ? String(Math.round(1000 * Number(lockedForOrigin.harvest_ready_share ?? weekShare)) / 10) : readyText}
                aria-invalid={!lockedForOrigin && !readyValid}
                disabled={Boolean(lockedForOrigin) || busy !== null}
                onChange={(e) => setReadyDraft({ key: weekShareKey, text: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && readyValid) void runPreview()
                }}
                title={
                  lockedForOrigin
                    ? `W${originWeek}’s official forecast is locked with this Ready %. Try other values in the table below (What-if).`
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
        <div className={`${wpd.controlButtons} ${styles.forecastButtons}`}>
          <button type="button" className={`button button-secondary ${wpd.helpButton}`} onClick={() => setShowSettings(true)} aria-haspopup="dialog">
            Forecast settings
          </button>
          <button type="button" className={`button button-secondary ${wpd.helpButton}`} onClick={() => setShowAudit(true)} disabled={!view} aria-haspopup="dialog">
            How it was made
          </button>
          <button type="button" className={`button button-primary ${wpd.helpButton}`} onClick={() => void runPreview()} disabled={busy !== null}>
            {busy === 'preview' ? 'Generating…' : 'Generate forecast'}
          </button>
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

      {runs.isPending || sampling.isPending || stored.loading ? (
        <LoadingState />
      ) : runs.error || sampling.error ? (
        <ErrorState error={runs.error ?? sampling.error} />
      ) : !view || !shown ? (
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
                on this page only. The {view.source === 'locked' ? `${STATUS_LABEL[view.status]} forecast locked` : 'preliminary forecast saved'} {dateTime(view.at)} is
                unchanged, and stays what Production Totals and accuracy use.
              </span>
              <span className={styles.experimentActions}>
                <button type="button" className="button button-secondary" onClick={resetTrial} disabled={busy !== null}>
                  Reset to saved forecast
                </button>
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
          <ForecastTable
            readyShare={
              adjustable
                ? {
                    saved: view.harvestReadyShare!,
                    value: trialShare ?? view.harvestReadyShare!,
                    fieldKey: `${viewKey}:${resets}`,
                    onChange: (share) => setTrial({ key: viewKey, share }),
                  }
                : undefined
            }
            experimental={experimenting}
            onRegenerate={showPreliminary && stored.outdated ? () => void runPreview() : undefined}
            regenerating={busy === 'preview'}
            view={shown}
            // Comparisons with what happened belong to the saved forecast: hidden while experimenting.
            scored={view.runId && !experimenting ? live.data?.scored.find((s) => s.run.id === view.runId) : undefined}
            actual={view.runId && !experimenting ? live.data?.actual.runs.find((s) => s.run.id === view.runId) : undefined}
            accuracy={live.data?.accuracy}
            actualAccuracy={live.data?.actual}
            outdated={showPreliminary && stored.outdated}
            onBackToLocked={showPreliminary && runs.data?.length ? () => setSelectedRun(runs.data![0].id) : undefined}
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

      {view && <Snapshots runs={runs.data ?? []} shown={view.runId} onShow={(id) => setSelectedRun(id)} />}
      {!runs.isPending && <AccuracyPanel crop={crop} accuracy={live.data?.accuracy} actual={live.data?.actual} />}
      {live.error && <div className={styles.error}>Couldn’t score forecasts: {live.error.message}</div>}
      {view && <AuditDialog open={showAudit} onClose={() => setShowAudit(false)} view={view} />}
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

const STATUS_TEXT: Record<WeekStatus, string> = {
  pending: 'Not yet',
  in_progress: 'This week',
  provisional: 'Waiting for next visit',
  settled: 'Settled',
  unreliable: 'Unreliable',
}

const pctSigned = (x: number | null) => (x === null ? '—' : `${x >= 0 ? '+' : ''}${Math.round(100 * x)}%`)

function ForecastTable({
  view,
  scored,
  actual,
  accuracy,
  actualAccuracy,
  outdated,
  onRegenerate,
  readyShare,
  experimental,
  regenerating,
  onBackToLocked,
}: {
  view: ForecastView
  /** Ready % can be tried on this forecast (saved: its own share; value: the one shown). Absent: read-only. */
  readyShare?: { saved: number; value: number; fieldKey: string; onChange: (share: number) => void }
  /** What-if: next week shows a Ready % typed in, not the saved forecast. */
  experimental?: boolean
  /** A saved preliminary forecast whose data changed since it was generated. */
  outdated?: boolean
  onRegenerate?: () => void
  regenerating?: boolean
  /** The locked forecast scored against what was recorded since (locked lifecycle forecasts only). */
  scored?: ScoredRun
  /** The locked forecast against the actual kg entered (locked forecasts). */
  actual?: ActualScoredRun
  accuracy?: LiveAccuracy
  actualAccuracy?: ActualAccuracy
  onBackToLocked?: () => void
}) {
  const marketing = view.weeks.filter((w) => w.window === 'marketing')
  const outlook = view.weeks.filter((w) => w.window === 'outlook')
  const observed = Boolean(scored)
  const withActual = Boolean(actual)
  const columns = 7 + (observed ? 4 : 0) + (withActual ? 2 : 0)
  const scoredWeek = (h: number) => scored?.weeks.find((w) => w.horizon === h)
  const actualWeek = (h: number) => actual?.weeks.find((w) => w.horizon === h)
  const horizonStatus = (h: number) =>
    view.basis === 'breaker_only' ? actualAccuracy?.horizons.find((a) => a.basis === 'breaker_only' && a.horizon === h) : accuracy?.horizons.find((a) => a.horizon === h)
  const breakerOnly = view.basis === 'breaker_only'

  const row = (w: ForecastView['weeks'][number]) => {
    if (!w.available) {
      return (
        <tr key={w.horizon} className={`${w.window === 'outlook' ? styles.outlookRow : ''} ${styles.unavailableRow}`} title={w.unavailableReason ?? 'Not available'}>
          <th scope="row">
            W{w.week}
            <span className={styles.ahead}>+{w.horizon}</span>
          </th>
          {Array.from({ length: columns - 1 }, (_, i) => (
            <td key={i} className={styles.dash}>
              —
            </td>
          ))}
        </tr>
      )
    }
    const o = scoredWeek(w.horizon)
    const a = actualWeek(w.horizon)
    const hs = horizonStatus(w.horizon)
    const block = o?.status === 'unreliable' ? scored?.units.find((u) => u.block && u.weeks.includes(o.targetIndex)) : undefined
    const afwNeeded = w.afwG === null
    const trial = Boolean(experimental) && w.horizon === 1
    return (
      <tr key={w.horizon} className={w.window === 'outlook' ? styles.outlookRow : undefined} title={componentsTitle(w, view.scale, view.basis)}>
        <th scope="row">
          W{w.week}
          <span className={styles.ahead}>+{w.horizon}</span>
        </th>
        <td className={styles.readyCell}>
          {breakerOnly && w.horizon === 1 ? (
            readyShare ? (
              <ReadyInput
                key={readyShare.fieldKey}
                value={Math.round(1000 * readyShare.value) / 10}
                saved={Math.round(1000 * readyShare.saved) / 10}
                busy={Boolean(regenerating)}
                onChange={(percent) => readyShare.onChange(percent / 100)}
              />
            ) : (
              <span title="Ready % can be tried once next week has a projection (Breakers counted and an AFW entered)">{formatPercent(view.harvestReadyShare)}</span>
            )
          ) : (
            <span className={styles.dash} title={breakerOnly ? undefined : 'Full lifecycle forecasts use stage-transition modelling, not one harvest-ready %'}>
              —
            </span>
          )}
        </td>
        <td className={trial ? styles.experimental : undefined}>{formatCount(w.cropFruit)}</td>
        <td title={w.afwSource ?? 'No AFW entered for this variety: enter one in Weekly Plant Data to calculate kg and cases.'}>
          {afwNeeded ? '—' : w.afwG!.toFixed(0)}
          {w.afwKind === 'grower' && <span className={styles.grower}>Grower</span>}
        </td>
        <td className={`${styles.kg} ${trial ? styles.experimental : ''}`} title={trial ? 'What-if: recalculated with the Ready % you typed, not saved' : undefined}>
          {afwNeeded ? '—' : formatCount(w.kg)}
        </td>
        <td className={trial ? styles.experimental : undefined}>{afwNeeded ? '—' : formatCount(w.cases)}</td>
        {withActual && (
          <>
            <td className={styles.observed} title={a?.status === 'awaiting_actual' ? 'Enter the actual kg in Weekly Plant Data' : undefined}>
              {a?.actualKg !== null && a?.actualKg !== undefined ? formatCount(a.actualKg) : a?.status === 'awaiting_actual' ? 'Awaiting' : '—'}
            </td>
            <td
              className={styles.observed}
              title={a?.impliedShare != null ? `The harvest-ready share that would have matched: ${Math.round(100 * a.impliedShare)}%` : a?.status === 'not_scorable' ? 'No forecast kg (no AFW) or no harvest: not scored' : undefined}
            >
              {a?.status === 'scored' ? pctSigned(a.error) : a?.status === 'not_scorable' ? 'Not scorable' : '—'}
            </td>
          </>
        )}
        {observed && (
          <>
            <td className={styles.observed}>{o?.observedFruit === null || o?.observedFruit === undefined ? '—' : formatCount(o.observedFruit * view.scale)}</td>
            <td className={styles.observed} title={o?.actualAfw ? `Observed peppers × ${o.actualAfw} g entered AFW` : 'Enter this week’s actual AFW to see observed kg'}>
              {formatCount(o?.observedKg ?? null)}
            </td>
            <td className={styles.observed} title={block ? `Scored together with ${block.weeks.length - 1} following week(s): forecast ${block.forecastFruit.toFixed(0)} vs observed ${block.observedFruit} sampled peppers` : undefined}>
              {o?.status === 'settled' ? `${pctSigned(o.fruitError)} · ${pctSigned(o.kgError)}` : block ? `block ${pctSigned(block.observedFruit ? block.forecastFruit / block.observedFruit - 1 : null)}` : '—'}
            </td>
            <td>
              <span className={`${styles.weekStatus} ${styles[`ws_${o?.status ?? 'pending'}`]}`} title={o?.reason ?? (o?.coverage !== null && o?.coverage !== undefined ? `${Math.round(100 * o.coverage)}% of stems visited` : undefined)}>
                {STATUS_TEXT[o?.status ?? 'pending']}
              </span>
            </td>
          </>
        )}
        <td>
          {hs?.status === 'validated' ? (
            <span className={styles.validated} title={`Validated by ${'fruit' in hs ? hs.fruit.n : hs.kg.n} live forecasts`}>
              Validated
            </span>
          ) : (
            <span className={styles.lowConfidence} title={hs ? `Not yet validated: ${hs.reasons.join('; ')}` : 'Not yet validated by live forecasts'}>
              Low<span className={styles.hideNarrow}> confidence</span>
            </span>
          )}
        </td>
      </tr>
    )
  }

  const afwMissing = view.weeks.some((w) => w.available && w.afwG === null)
  const incompleteWalk = view.coverage.visited !== null && view.coverage.visited < view.coverage.expected
  const anyUnavailable = view.weeks.some((w) => !w.available)
  const fiveClosed = scored && scored.weeks.filter((w) => w.horizon <= MARKETING_WEEKS).every((w) => w.status === 'settled' || w.status === 'unreliable')
  const observedFive = fiveClosed ? scored!.weeks.filter((w) => w.horizon <= MARKETING_WEEKS) : null
  return (
    <div className={styles.card}>
      <div className={styles.cardHead}>
        <h2 className={styles.compactTitle}>
          Forecast from W{view.originWeek}
          <span className={styles.titleSep}>·</span>
          <span className={view.status === 'official' || view.status === 'late' ? styles.statusOfficial : styles.statusPreliminary}>{STATUS_LABEL[view.status]}</span>
          {view.confidence.level === 'experimental' && (
            <>
              <span className={styles.titleSep}>·</span>
              <span className={styles.statusExperimental}>Experimental</span>
            </>
          )}
        </h2>
        {onBackToLocked && (
          <button type="button" className="button button-link" onClick={onBackToLocked}>
            Back to locked forecasts
          </button>
        )}
      </div>

      {(outdated || afwMissing || incompleteWalk) && (
        <ul className={styles.warnings}>
          {outdated && (
            <li>
              May be outdated: W{view.originWeek} data or the forecast rules changed since it was generated.{' '}
              {onRegenerate && (
                <button type="button" className="button button-link" onClick={onRegenerate} disabled={regenerating}>
                  {regenerating ? 'Generating…' : 'Regenerate'}
                </button>
              )}
            </li>
          )}
          {afwMissing && <li>No AFW entered: kg and cases need an AFW (Weekly Plant Data).</li>}
          {incompleteWalk && (
            <li>
              Incomplete walkthrough: {view.coverage.visited} of {view.coverage.expected} stems{view.coverage.share !== null && view.coverage.share < LOW_COVERAGE ? ' (low coverage)' : ''}.
            </li>
          )}
        </ul>
      )}

      <table className={styles.table}>
        <thead>
          <tr>
            <th scope="col">Week</th>
            <th scope="col" title="Breakers only: the share of this Friday’s Breakers expected to be harvested next week. Type another % to try it: next week’s kg and cases update on this page only; the saved forecast is unchanged.">
              Ready %
            </th>
            <th scope="col" title="Peppers expected to be harvested on the whole crop">
              Peppers
            </th>
            <th scope="col" title="Average fruit weight, grams (Grower: the AFW you entered for that week)">
              AFW g
            </th>
            <th scope="col">Kg</th>
            <th scope="col" title={view.caseWeightKg ? `${view.caseWeightKg} kg per case` : 'Set a case weight to show cases'}>
              Cases
            </th>
            {withActual && (
              <>
                <th scope="col" className={styles.observedHead} title="Actual kilograms harvested that week, entered in Weekly Plant Data (the newest entry)">
                  Actual kg
                </th>
                <th scope="col" className={styles.observedHead} title="Forecast kg ÷ actual kg − 1. Positive = forecast too high.">
                  vs actual
                </th>
              </>
            )}
            {observed && (
              <>
                <th scope="col" className={styles.observedHead} title="Peppers recorded Harvested that week on this forecast’s sampled stems, scaled to the crop">
                  Observed peppers
                </th>
                <th scope="col" className={styles.observedHead} title="Observed peppers × the actual AFW entered for that week">
                  Observed kg
                </th>
                <th scope="col" className={styles.observedHead} title="Forecast ÷ observed − 1: peppers · kg. Positive = forecast too high.">
                  Error
                </th>
                <th scope="col">Observed</th>
              </>
            )}
            <th scope="col">Confidence</th>
          </tr>
        </thead>
        <tbody>
          <tr className={styles.groupRow}>
            <th colSpan={columns}>Weeks 1–{MARKETING_WEEKS}</th>
          </tr>
          {marketing.map(row)}
          <tr className={styles.totalRow}>
            <th scope="row">Weeks 1–{MARKETING_WEEKS} total</th>
            <td />
            <td className={experimental && view.marketing.cropFruit !== null ? styles.experimental : undefined}>{formatCount(view.marketing.cropFruit)}</td>
            <td />
            <td className={`${styles.kg} ${experimental && view.marketing.kg !== null ? styles.experimental : ''}`}>{formatCount(view.marketing.kg)}</td>
            <td className={experimental && view.marketing.cases !== null ? styles.experimental : undefined}>{formatCount(view.marketing.cases)}</td>
            {withActual && (
              <>
                <td />
                <td />
              </>
            )}
            {observed && (
              <>
                <td>{observedFive ? formatCount(observedFive.reduce((a, w) => a + (w.observedFruit ?? 0), 0) * view.scale) : '—'}</td>
                <td>{observedFive && observedFive.every((w) => w.observedKg !== null) ? formatCount(observedFive.reduce((a, w) => a + w.observedKg!, 0)) : '—'}</td>
                <td>
                  {observedFive
                    ? pctSigned((view.marketing.cropFruit ?? 0) / Math.max(1, observedFive.reduce((a, w) => a + (w.observedFruit ?? 0), 0) * view.scale) - 1)
                    : '—'}
                </td>
                <td />
              </>
            )}
            <td />
          </tr>
          <tr className={`${styles.groupRow} ${styles.outlookGroup}`}>
            <th colSpan={columns}>Weeks {MARKETING_WEEKS + 1}–{FORECAST_WEEKS} · outlook</th>
          </tr>
          {outlook.map(row)}
        </tbody>
      </table>

      {anyUnavailable && (
        <p className={styles.footnote}>
          — {breakerOnly ? 'Only Breakers are recorded, so only next week is forecast; longer-range weeks need full lifecycle observations.' : 'Not enough full lifecycle history for this week yet.'}
        </p>
      )}
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

const pct = (x: number | null) => (x === null ? '—' : `${Math.round(100 * x)}%`)

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

/** Live accuracy by week ahead (official forecasts only) and, separately, the historical replay. */
function AccuracyPanel({ crop, accuracy, actual }: { crop: Crop; accuracy: LiveAccuracy | undefined; actual: ActualAccuracy | undefined }) {
  const [replay, setReplay] = useState<HistoricalReplay | null | 'none'>(null)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const statusLabel = { collecting: 'Collecting', validated: 'Validated', not_validated: 'Not validated' } as const
  const metricCell = (m: { wape: number | null; bias: number | null; n: number }) => (m.n === 0 ? '—' : `${pct(m.wape)} · ${pctSigned(m.bias)}`)

  return (
    <div className={styles.card}>
      <h2 className={styles.title}>Forecast accuracy</h2>
      {actual && <ActualAccuracyTable actual={actual} metricCell={(m) => (m.n === 0 ? '—' : `${pct(m.wape)} · ${pctSigned(m.bias)}`)} />}
      <h3 className={styles.replayTitle}>Against recorded harvests (full lifecycle forecasts)</h3>
      {accuracy && accuracy.officialRuns + accuracy.lateRuns === 0 && (
        <p className={styles.fate}>No full lifecycle forecast locked yet for {crop.name}: Breakers-only forecasts are scored against actual kg above.</p>
      )}
      {(!accuracy || accuracy.officialRuns + accuracy.lateRuns > 0) && (
      <>
      <p className={styles.subtitle}>
        Live: each official forecast against the peppers later recorded Harvested on its sampled stems. Error = WAPE · bias (positive = forecast too high).
        Unsampled or flagged weeks are scored together with the following week, never as zero. Late forecasts aren’t counted
        {accuracy ? ` (${accuracy.officialRuns} official, ${accuracy.lateRuns} late so far).` : '.'}
      </p>
      {accuracy && (
        <table className={styles.table}>
          <thead>
            <tr>
              <th scope="col">Week ahead</th>
              <th scope="col" title="Improvement goal for the peppers error (WAPE); meeting it alone doesn’t validate a week ahead">
                Goal
              </th>
              <th scope="col">Peppers error</th>
              <th scope="col">kg error</th>
              <th scope="col" title="Scored weeks or blocks">
                Scored
              </th>
              <th scope="col" title="Stems visited in the scored weeks">
                Coverage
              </th>
              <th scope="col">Status</th>
            </tr>
          </thead>
          <tbody>
            <tr className={styles.groupRow}>
              <th colSpan={7}>Marketing forecast</th>
            </tr>
            {accuracy.horizons.map((h) => (
              <Fragment key={h.horizon}>
                {h.horizon === MARKETING_WEEKS + 1 && (
                  <>
                    <tr className={styles.totalRow}>
                      <th scope="row">Weeks 1–{MARKETING_WEEKS} total</th>
                      <td />
                      <td>{metricCell(accuracy.marketing.fruit)}</td>
                      <td>{metricCell(accuracy.marketing.kg)}</td>
                      <td>{accuracy.marketing.fruit.n}</td>
                      <td />
                      <td />
                    </tr>
                    <tr className={`${styles.groupRow} ${styles.outlookGroup}`}>
                      <th colSpan={7}>Longer-range outlook</th>
                    </tr>
                  </>
                )}
                <tr className={h.window === 'outlook' ? styles.outlookRow : undefined}>
                  <th scope="row">+{h.horizon}</th>
                  <td>{pct(h.goal)}</td>
                  <td>{metricCell(h.fruit)}</td>
                  <td>{metricCell(h.kg)}</td>
                  <td>
                    {h.fruit.n}
                    {h.blocks > 0 && <span className={styles.ahead}>{h.blocks} block{h.blocks === 1 ? '' : 's'}</span>}
                  </td>
                  <td>{pct(h.coverage)}</td>
                  <td>
                    <span className={h.status === 'validated' ? styles.validated : styles.lowConfidence} title={h.reasons.join('; ') || undefined}>
                      {statusLabel[h.status]}
                    </span>
                  </td>
                </tr>
              </Fragment>
            ))}
          </tbody>
        </table>
      )}
      <p className={styles.fate}>
        A week ahead is validated only with at least {MIN_SETTLED} settled official forecasts, bias within ±{Math.round(100 * MAX_ABS_BIAS)}%, sampling coverage of at
        least {Math.round(100 * MIN_COVERAGE)}% and error within its goal.
      </p>
      </>
      )}

      <div className={styles.replay}>
        <h3 className={styles.replayTitle}>
          Historical replay <span className={`${styles.badge} ${styles.badge_experimental}`}>Unverified records · not validation</span>
        </h3>
        <p className={styles.subtitle}>
          Re-runs past weeks of {crop.name} as if forecasting then, using only what had been recorded by each week’s end. The history was recorded before
          explicit stem checks and may contain node mix-ups, so this shows how the model behaves on it, not how accurate it is. It never counts toward
          validation.
        </p>
        {replay === null ? (
          <button
            type="button"
            className="button button-secondary"
            disabled={running}
            onClick={async () => {
              setRunning(true)
              setError(null)
              try {
                setReplay((await runHistoricalReplay(crop)) ?? 'none')
              } catch (err) {
                setError(err instanceof Error ? err.message : String(err))
              } finally {
                setRunning(false)
              }
            }}
          >
            {running ? 'Replaying…' : 'Run historical replay'}
          </button>
        ) : replay === 'none' ? (
          <p className={styles.fate}>Not enough sampled history to replay.</p>
        ) : (
          <table className={`${styles.table} ${styles.replayTable}`}>
            <thead>
              <tr>
                <th scope="col">Peppers error</th>
                {Array.from({ length: FORECAST_WEEKS }, (_, k) => (
                  <th key={k} scope="col">
                    +{k + 1}
                  </th>
                ))}
                <th scope="col">Weeks 1–5</th>
              </tr>
            </thead>
            <tbody>
              {replay.reports.map((r) => (
                <tr key={r.candidate.id}>
                  <th scope="row">{r.candidate.label}</th>
                  {r.fruitByHorizon.map((m, k) => (
                    <td key={k}>{metricCell(m)}</td>
                  ))}
                  <td>{metricCell(r.marketingFruit)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {error && <div className={styles.error}>{error}</div>}
      </div>
    </div>
  )
}

/** Official forecasts against the actual kg entered, by basis and week ahead; the implied harvest-ready share for Breakers only. */
function ActualAccuracyTable({ actual, metricCell }: { actual: ActualAccuracy; metricCell: (m: { wape: number | null; bias: number | null; n: number }) => string }) {
  const statusLabel = { collecting: 'Collecting', validated: 'Validated', not_validated: 'Not validated' } as const
  const shares = actual.runs
    .filter((r) => r.run.kind === 'official' && r.run.basis === 'breaker_only')
    .flatMap((r) => r.weeks.filter((w) => w.status === 'scored' && w.impliedShare !== null).map((w) => w.impliedShare!))
  const shown = actual.horizons.filter((h) => h.basis === 'breaker_only' || h.kg.n > 0)
  return (
    <>
      <h3 className={styles.replayTitle}>Against actual harvested kg</h3>
      <p className={styles.subtitle}>
        Each official forecast’s kg against the actual kg entered in Weekly Plant Data for that week (the newest entry; corrections count, the forecast never
        changes). Error = WAPE · bias (positive = forecast too high). Weeks without an actual entry wait; forecasts without kg (no AFW) aren’t scored.
      </p>
      <table className={styles.table}>
        <thead>
          <tr>
            <th scope="col">Basis</th>
            <th scope="col">Week ahead</th>
            <th scope="col">Goal</th>
            <th scope="col">kg error</th>
            <th scope="col">Scored</th>
            <th scope="col" title="Mean share of sampled stems checked in the forecasts’ sampling weeks">Coverage</th>
            <th scope="col">Status</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((h) => (
            <tr key={`${h.basis}:${h.horizon}`}>
              <th scope="row">{BASIS_NAME[h.basis]}</th>
              <td>+{h.horizon}</td>
              <td>{pct(h.goal)}</td>
              <td>{metricCell(h.kg)}</td>
              <td>{h.kg.n}</td>
              <td>{pct(h.coverage)}</td>
              <td>
                <span className={h.status === 'validated' ? styles.validated : styles.lowConfidence} title={h.reasons.join('; ') || undefined}>
                  {statusLabel[h.status]}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className={styles.fate}>
        {shares.length
          ? `Implied harvest-ready share (Breakers only, ${shares.length} scored week${shares.length === 1 ? '' : 's'}): mean ${pct(shares.reduce((a, b) => a + b, 0) / shares.length)}, range ${pct(Math.min(...shares))}–${pct(Math.max(...shares))}. A diagnostic: the share changes only when you change it in Forecast settings.`
          : 'Implied harvest-ready share: appears once Breakers-only forecasts are scored against actual kg.'}
      </p>
    </>
  )
}

function Snapshots({
  runs,
  shown,
  onShow,
}: {
  runs: { id: string; origin_year: number; origin_week: number; kind: string; locked_at: string; marketing_kg: number | null; confidence: string; basis: 'lifecycle' | 'breaker_only' }[]
  shown: string | null
  onShow: (id: string) => void
}) {
  if (runs.length === 0) return null
  return (
    <div className={styles.card}>
      <h2 className={styles.title}>Locked forecasts</h2>
      <p className={styles.subtitle}>Every forecast locked for this variety. They are never recalculated: each is compared with the actual kg entered (and full lifecycle forecasts also with recorded harvests).</p>
      <table className={styles.table}>
        <thead>
          <tr>
            <th scope="col">Sampling week</th>
            <th scope="col">Status</th>
            <th scope="col">Basis</th>
            <th scope="col">Locked</th>
            <th scope="col">Weeks 1–5 kg</th>
            <th scope="col">Confidence</th>
            <th scope="col" />
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => (
            <tr key={r.id} className={r.id === shown ? styles.shownRow : undefined}>
              <th scope="row">
                W{r.origin_week} {r.origin_year}
              </th>
              <td>{r.kind === 'official' ? 'Official' : 'Late'}</td>
              <td>{BASIS_NAME[r.basis]}</td>
              <td>{dateTime(r.locked_at)}</td>
              <td className={styles.kg}>{r.basis === 'breaker_only' ? 'next week only' : formatCount(r.marketing_kg)}</td>
              <td>{r.confidence === 'experimental' ? 'Experimental' : 'Standard'}</td>
              <td>
                <button type="button" className="button button-link" onClick={() => onShow(r.id)} disabled={r.id === shown}>
                  {r.id === shown ? 'Shown' : 'Show'}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
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
    <label className={`field ${wpd.yearControl} ${styles.caseWeight}`}>
      <span className="field-label">Case kg</span>
      <input
        className="input"
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

