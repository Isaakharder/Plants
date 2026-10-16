import { Fragment, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Dialog } from '../../components/Dialog'
import { EmptyState, ErrorState, LoadingState } from '../../components/States'
import { useCrops } from '../crops/api'
import { sortCrops, type Crop } from '../crops/model'
import { useOrganization } from '../organization/OrganizationProvider'
import { ProjectionsTabs } from '../projections/ProjectionsTabs'
import wpd from '../projections/WeeklyPlantDataTab.module.css'
import {
  computePreview,
  currentWeek,
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
  type HistoricalReplay,
  type Preview,
} from './api'
import { MAX_ABS_BIAS, MIN_COVERAGE, MIN_SETTLED, type LiveAccuracy, type ScoredRun, type WeekStatus } from './engine/live'
import { FORECAST_WEEKS, MARKETING_WEEKS } from './engine/types'
import { weekStartInstant } from './engine/weeks'
import {
  STATUS_LABEL,
  componentsTitle,
  formatCount,
  statusExplanation,
  viewFromPreview,
  viewFromRun,
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
  const [selectedRun, setSelectedRun] = useState<string | null>(null)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [busy, setBusy] = useState<'preview' | 'lock' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showAudit, setShowAudit] = useState(false)

  // The sampling week a preview starts from: the latest week with any visit (this week once sampling has begun).
  const samplingRows = sampling.data ?? []
  const latestSampled = [...samplingRows].reverse().find((r) => r.visited_stems > 0 && r.iso_week <= now.week)
  const originWeek = latestSampled?.iso_week ?? now.week
  const originRow = samplingRows.find((r) => r.iso_week === originWeek)
  const currentRow = samplingRows.find((r) => r.iso_week === now.week)

  const shownRunId = selectedRun ?? (preview ? null : runs.data?.[0]?.id ?? null)
  const shownRun = runs.data?.find((r) => r.id === shownRunId)
  const runWeeks = useForecastRunWeeks(shownRun?.id)
  const view: ForecastView | null = useMemo(() => {
    if (preview && !selectedRun) return viewFromPreview(preview, crop.case_weight_kg === null ? null : Number(crop.case_weight_kg))
    if (shownRun && runWeeks.data) return viewFromRun(shownRun, runWeeks.data)
    return null
  }, [preview, selectedRun, shownRun, runWeeks.data, crop.case_weight_kg])

  const lockedThisWeek = runs.data?.find((r) => r.origin_year === now.year && r.origin_week === now.week)
  const firstTargetStarts = weekStartInstant(now.index + 1)

  async function runPreview() {
    setBusy('preview')
    setError(null)
    try {
      setPreview(await computePreview(crop, now.year, originWeek, live.data?.accuracy.validatedHorizons ?? []))
      setSelectedRun(null)
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
      setPreview(null)
      setSelectedRun(res?.run_id ?? null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  const completedUnlocked = samplingRows.filter((r) => r.state === 'complete' && !runs.data?.some((run) => run.origin_year === now.year && run.origin_week === r.iso_week))

  return (
    <section className={wpd.section} aria-label="Harvest Forecast">
      <div className={wpd.toolbar}>
        <ProjectionsTabs />
        <div className={wpd.selectors}>
          <label className={`field ${wpd.control}`}>
            <span className="field-label">Variety</span>
            <select className="input" value={crop.id} onChange={(e) => onSelect(e.target.value)}>
              {crops.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          {/* Re-mounts when the saved value changes, so the field shows it. */}
          <CaseWeight key={String(crop.case_weight_kg)} crop={crop} />
        </div>
        <div className={wpd.controlButtons}>
          <button type="button" className={`button button-secondary ${wpd.helpButton}`} onClick={() => setShowAudit(true)} disabled={!view} aria-haspopup="dialog">
            How it was made
          </button>
          <button type="button" className={`button button-primary ${wpd.helpButton}`} onClick={() => void runPreview()} disabled={busy !== null}>
            {busy === 'preview' ? 'Generating…' : 'Generate forecast'}
          </button>
        </div>
      </div>

      <LockStatus
        week={now.week}
        current={currentRow}
        locked={lockedThisWeek}
        job={jobs.data?.find((j) => j.year === now.year && j.week === now.week) ?? null}
        firstTargetStarts={firstTargetStarts.toISOString()}
        pending={completedUnlocked.map((r) => r.iso_week)}
        busy={busy === 'lock'}
        onLock={(w) => void lockNow(w)}
      />
      {error && <div className={styles.error}>{error}</div>}

      {runs.isPending || sampling.isPending ? (
        <LoadingState />
      ) : runs.error || sampling.error ? (
        <ErrorState error={runs.error ?? sampling.error} />
      ) : !view ? (
        <EmptyState
          title={`No forecast for ${crop.name} yet`}
          description={`The official forecast locks automatically when a week’s sampling is marked complete in the collector. Generate forecast shows one now from the W${originWeek} sampling${originRow && originRow.state !== 'complete' ? ' (preliminary: not marked complete)' : ''}.`}
        />
      ) : (
        <>
          <ForecastTable
            view={view}
            scored={view.runId ? live.data?.scored.find((s) => s.run.id === view.runId) : undefined}
            accuracy={live.data?.accuracy}
            onBackToLocked={preview && runs.data?.length ? () => { setPreview(null); setSelectedRun(null) } : undefined}
          />
          <Snapshots runs={runs.data ?? []} shown={view.runId} onShow={(id) => { setSelectedRun(id); setPreview(null) }} />
        </>
      )}
      {!runs.isPending && <AccuracyPanel crop={crop} accuracy={live.data?.accuracy} />}
      {live.error && <div className={styles.error}>Couldn’t score forecasts: {live.error.message}</div>}
      {view && <AuditDialog open={showAudit} onClose={() => setShowAudit(false)} view={view} />}
    </section>
  )
}

const JOB_TEXT: Record<string, (job: { last_error: string | null; next_attempt_at: string }) => string> = {
  pending: () => 'locking on the server…',
  running: () => 'locking on the server…',
  waiting_for_sync: (j) => `waiting for the phone to sync before locking: ${j.last_error ?? ''}`,
  retry: (j) => `the server will retry at ${dateTime(j.next_attempt_at)} (${j.last_error ?? 'error'})`,
  failed: (j) => `the server couldn’t lock it: ${j.last_error ?? 'unknown error'}`,
}

function LockStatus(props: {
  week: number
  current: { visited_stems: number; expected_stems: number; checked_stems: number; state: string; completed_at: string | null } | undefined
  locked: { kind: string; locked_at: string } | undefined
  job: { status: string; last_error: string | null; next_attempt_at: string } | null
  firstTargetStarts: string
  pending: number[]
  busy: boolean
  onLock: (week: number) => void
}) {
  const { week, current, locked } = props
  return (
    <div className={styles.status}>
      <span>
        <strong>W{week} sampling:</strong>{' '}
        {current?.state === 'complete'
          ? `complete${current.completed_at ? ` (${dateTime(current.completed_at)})` : ''}`
          : current && current.visited_stems > 0
            ? `in progress · ${current.checked_stems} of ${current.expected_stems} stems checked`
            : 'not started'}
      </span>
      <span>
        <strong>Official forecast:</strong>{' '}
        {locked
          ? `${locked.kind === 'official' ? 'locked' : 'locked late'} ${dateTime(locked.locked_at)}`
          : props.job && props.job.status !== 'done' && props.job.status !== 'superseded'
            ? JOB_TEXT[props.job.status]?.(props.job) ?? props.job.status
            : `locked on the server when W${week} sampling is marked complete and synced (on time until ${dateTime(props.firstTargetStarts)})`}
      </span>
      {props.pending.length > 0 && (
        <span className={styles.pending}>
          {props.pending.map((w) => (
            <button key={w} type="button" className="button button-secondary" disabled={props.busy} onClick={() => props.onLock(w)}>
              {props.busy ? 'Locking…' : `Lock W${w} forecast now`}
            </button>
          ))}
        </span>
      )}
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
  accuracy,
  onBackToLocked,
}: {
  view: ForecastView
  /** The locked forecast scored against what was recorded since (locked forecasts only). */
  scored?: ScoredRun
  accuracy?: LiveAccuracy
  onBackToLocked?: () => void
}) {
  const marketing = view.weeks.filter((w) => w.window === 'marketing')
  const outlook = view.weeks.filter((w) => w.window === 'outlook')
  const showCases = view.caseWeightKg !== null
  const observed = Boolean(scored)
  const columns = 5 + (showCases ? 1 : 0) + (observed ? 4 : 0)
  const scoredWeek = (h: number) => scored?.weeks.find((w) => w.horizon === h)
  const horizonStatus = (h: number) => accuracy?.horizons.find((a) => a.horizon === h)

  const row = (w: ForecastView['weeks'][number]) => {
    const o = scoredWeek(w.horizon)
    const hs = horizonStatus(w.horizon)
    const block = o?.status === 'unreliable' ? scored?.units.find((u) => u.block && u.weeks.includes(o.targetIndex)) : undefined
    return (
      <tr key={w.horizon} className={w.window === 'outlook' ? styles.outlookRow : undefined} title={componentsTitle(w, view.scale)}>
        <th scope="row">
          W{w.week}
          <span className={styles.ahead}>+{w.horizon}</span>
        </th>
        <td>{formatCount(w.cropFruit)}</td>
        <td title={w.afwSource ?? undefined}>
          {w.afwG === null ? '—' : w.afwG.toFixed(0)}
          {w.afwKind === 'grower' && <span className={styles.grower}>Grower</span>}
        </td>
        <td className={styles.kg}>{formatCount(w.kg)}</td>
        {showCases && <td>{formatCount(w.cases)}</td>}
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
            <span className={styles.validated} title={`Validated by ${hs.fruit.n} live forecasts`}>
              Validated
            </span>
          ) : (
            <span className={styles.lowConfidence} title={hs ? `Not yet validated: ${hs.reasons.join('; ')}` : 'Not yet validated by live forecasts'}>
              Low confidence
            </span>
          )}
        </td>
      </tr>
    )
  }

  const fiveClosed = scored && scored.weeks.filter((w) => w.horizon <= MARKETING_WEEKS).every((w) => w.status === 'settled' || w.status === 'unreliable')
  const observedFive = fiveClosed ? scored!.weeks.filter((w) => w.horizon <= MARKETING_WEEKS) : null
  return (
    <div className={styles.card}>
      <div className={styles.cardHead}>
        <div>
          <h2 className={styles.title}>
            Forecast from W{view.originWeek} sampling
            <span className={`${styles.badge} ${styles[`badge_${view.status}`]}`}>{STATUS_LABEL[view.status]}</span>
            {view.confidence.level === 'experimental' && <span className={`${styles.badge} ${styles.badge_experimental}`}>Experimental</span>}
          </h2>
          <p className={styles.subtitle}>
            {statusExplanation(view)} {view.source === 'locked' ? 'Locked' : 'Computed'} {dateTime(view.at)} · records observed to {dateTime(view.observedCutoff)} ·{' '}
            {view.sampleStems} sampled stems
          </p>
        </div>
        {onBackToLocked && (
          <button type="button" className="button button-link" onClick={onBackToLocked}>
            Back to locked forecasts
          </button>
        )}
      </div>

      {view.confidence.reasons.length > 0 && (
        <ul className={styles.reasons}>
          {view.confidence.reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      )}

      <table className={styles.table}>
        <thead>
          <tr>
            <th scope="col">Week</th>
            <th scope="col" title="Peppers expected to be harvested on the whole crop: sampled peppers × picking stems ÷ sampled stems">
              Peppers
            </th>
            <th scope="col" title="Forecast average fruit weight, grams (Grower: the AFW you entered for that week)">
              AFW g
            </th>
            <th scope="col">kg</th>
            {showCases && <th scope="col">Cases ({view.caseWeightKg} kg)</th>}
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
            <th colSpan={columns}>Marketing forecast · weeks 1–{MARKETING_WEEKS}</th>
          </tr>
          {marketing.map(row)}
          <tr className={styles.totalRow}>
            <th scope="row">Weeks 1–{MARKETING_WEEKS} total</th>
            <td>{formatCount(view.marketing.cropFruit)}</td>
            <td />
            <td className={styles.kg}>{formatCount(view.marketing.kg)}</td>
            {showCases && <td>{formatCount(view.marketing.cases)}</td>}
            {observed && (
              <>
                <td>{observedFive ? formatCount(observedFive.reduce((a, w) => a + (w.observedFruit ?? 0), 0) * view.scale) : '—'}</td>
                <td>{observedFive && observedFive.every((w) => w.observedKg !== null) ? formatCount(observedFive.reduce((a, w) => a + w.observedKg!, 0)) : '—'}</td>
                <td>
                  {observedFive
                    ? pctSigned(view.marketing.cropFruit / Math.max(1, observedFive.reduce((a, w) => a + (w.observedFruit ?? 0), 0) * view.scale) - 1)
                    : '—'}
                </td>
                <td />
              </>
            )}
            <td />
          </tr>
          <tr className={`${styles.groupRow} ${styles.outlookGroup}`}>
            <th colSpan={columns}>
              Longer-range outlook · weeks {MARKETING_WEEKS + 1}–{FORECAST_WEEKS} <span className={styles.groupNote}>not in the marketing total</span>
            </th>
          </tr>
          {outlook.map(row)}
        </tbody>
      </table>

      {view.fate && (
        <p className={styles.fate}>
          Of the fruit on the plants now (crop scale), the model expects {formatCount(view.fate.harvested)} to be harvested within {FORECAST_WEEKS} weeks,{' '}
          {formatCount(view.fate.aborted)} to abort, {formatCount(view.fate.pruned)} to be pruned and {formatCount(view.fate.stillOnPlant)} to still be on the plants
          after week {FORECAST_WEEKS}.
        </p>
      )}
    </div>
  )
}

const pct = (x: number | null) => (x === null ? '—' : `${Math.round(100 * x)}%`)

/** Live accuracy by week ahead (official forecasts only) and, separately, the historical replay. */
function AccuracyPanel({ crop, accuracy }: { crop: Crop; accuracy: LiveAccuracy | undefined }) {
  const [replay, setReplay] = useState<HistoricalReplay | null | 'none'>(null)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const statusLabel = { collecting: 'Collecting', validated: 'Validated', not_validated: 'Not validated' } as const
  const metricCell = (m: { wape: number | null; bias: number | null; n: number }) => (m.n === 0 ? '—' : `${pct(m.wape)} · ${pctSigned(m.bias)}`)

  return (
    <div className={styles.card}>
      <h2 className={styles.title}>Forecast accuracy</h2>
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

function Snapshots({ runs, shown, onShow }: { runs: { id: string; origin_year: number; origin_week: number; kind: string; locked_at: string; marketing_kg: number | null; confidence: string }[]; shown: string | null; onShow: (id: string) => void }) {
  if (runs.length === 0) return null
  return (
    <div className={styles.card}>
      <h2 className={styles.title}>Locked forecasts</h2>
      <p className={styles.subtitle}>Every forecast locked for this variety. They are never recalculated; comparisons with observed harvests come next.</p>
      <table className={styles.table}>
        <thead>
          <tr>
            <th scope="col">Sampling week</th>
            <th scope="col">Status</th>
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
              <td>{dateTime(r.locked_at)}</td>
              <td className={styles.kg}>{formatCount(r.marketing_kg)}</td>
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

