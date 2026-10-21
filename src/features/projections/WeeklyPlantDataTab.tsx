import { Fragment, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { useSearchParams } from 'react-router-dom'
import { EmptyState, ErrorState, LoadingState } from '../../components/States'
import { formatInteger } from '../../lib/format'
import { greenhouseIsoWeek, useGreenhouseWeek } from '../collector/greenhouseWeek'
import { useCrops } from '../crops/api'
import { sortCrops, stemsPerM2 } from '../crops/model'
import { useOrganization } from '../organization/OrganizationProvider'
import { Dialog } from '../../components/Dialog'
import {
  parseActualKg,
  useSamplingWeeks,
  useSaveWeeklyHarvestActual,
  useSaveWeeklyHarvestAfw,
  useHarvestWeekFlags,
  useSetHarvestCohorts,
  useWeeklyFruitLoss,
  useWeeklyHarvestActuals,
  useWeeklyHarvestAfw,
  useWeeklyHarvestable,
  useWeeklyPlantData,
  type ActualWeek,
  type AfwChange,
} from './api'
import {
  LADDER_AGES,
  AFW_MAX_G,
  coverageKind,
  coverageLabel,
  coverageTitle,
  cropYears,
  defaultYear,
  formatFruitLoss,
  fruitLossTitle,
  formatRate,
  ladderAgesWithHarvests,
  parseAfw,
  pickedKg,
  pickedKgTitle,
  weekTiming,
  weeksFromFirstSample,
  type SamplingWeekRow,
  type WeeklyFruitLossRow,
  type WeekTiming,
} from './model'
import { ProjectionsTabs } from './ProjectionsTabs'
import { CohortBar, CohortDetailPanel } from './CohortDetail'
import { cohortDetail, type TimelineContext } from './cohortTimeline'
import { useBasisSettings } from '../forecast/api'
import { basisAt } from '../forecast/engine/basis'
import { weekIndex } from '../forecast/engine/weeks'
import { harvestableKgTitle, harvestableWeek } from './harvestable'
import { SamplingDetail } from './SamplingDetail'
import { WeeklyPlantDataHelp } from './WeeklyPlantDataHelp'
import styles from './WeeklyPlantDataTab.module.css'

/**
 * Projections › Weekly Plant Data: per ISO week, how many peppers on the
 * sampled plants entered SetFruit, BreakerFruit and Harvested, per sampled m².
 * Calculated in the database (weekly_plant_data); see that migration for the rules.
 */
export function WeeklyPlantDataTab() {
  const organization = useOrganization()
  const crops = useCrops(organization.id)
  const [params, setParams] = useSearchParams()
  const [showSampling, setShowSampling] = useState(false)
  const [showHelp, setShowHelp] = useState(false)
  // The one expanded cohort row (variety · year · set week); clicking it again closes it.
  const [expanded, setExpanded] = useState<string | null>(null)
  const today = useGreenhouseWeek()

  const sorted = useMemo(() => sortCrops(crops.data ?? []), [crops.data])
  const crop = sorted.find((c) => c.id === params.get('crop')) ?? sorted[0]
  const years = crop ? cropYears(crop) : []
  const requestedYear = Number(params.get('year'))
  const year = years.includes(requestedYear) ? requestedYear : years.length ? defaultYear(years, greenhouseIsoWeek().year) : undefined

  const weeks = useWeeklyPlantData(crop?.id, year)
  const cohorts = useSetHarvestCohorts(crop?.id, year)
  const fruitLoss = useWeeklyFruitLoss(crop?.id, year)
  const sampling = useSamplingWeeks(crop?.id, year)
  const afw = useWeeklyHarvestAfw(crop?.id, year)
  const saveAfw = useSaveWeeklyHarvestAfw(organization.id, crop?.id, year)
  const actuals = useWeeklyHarvestActuals(crop?.id, year)
  const harvestable = useWeeklyHarvestable(crop?.id, year)
  const [actualWeek, setActualWeek] = useState<number | null>(null)
  // Typed but unsaved AFWs, per crop · year · harvest week (text as typed).
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [justSaved, setJustSaved] = useState(false)
  const tableRef = useRef<HTMLDivElement>(null)
  const fruitLossRows = useMemo(() => new Map((fruitLoss.data ?? []).map((row) => [row.iso_week, row])), [fruitLoss.data])
  const cohortRows = useMemo(() => new Map((cohorts.data ?? []).map((row) => [row.iso_week, row])), [cohorts.data])
  const samplingRows = useMemo(() => new Map((sampling.data ?? []).map((row) => [row.iso_week, row])), [sampling.data])
  // Presentation only: start at the first sampled week and show only the
  // cohort ages that have a harvest somewhere in the displayed weeks.
  const shownWeeks = useMemo(() => weeksFromFirstSample(weeks.data ?? []), [weeks.data])
  const ages = useMemo(
    () => ladderAgesWithHarvests(shownWeeks.flatMap((w) => cohortRows.get(w.iso_week) ?? [])),
    [shownWeeks, cohortRows],
  )
  const hiddenAges = LADDER_AGES.filter((age) => !ages.includes(age))
  // Cohort detail per set week (display only): ages labelled by what is known about each harvest week.
  const flags = useHarvestWeekFlags(crop?.id, year)
  const basisSettings = useBasisSettings(crop?.id)
  // Cheap (one entry per shown week): computed on each render.
  const details = (() => {
    if (!year || !cohorts.data) return new Map<number, ReturnType<typeof cohortDetail>>()
    const settings = (basisSettings.data ?? []).map((r) => ({
      fromYear: r.from_year,
      fromWeek: r.from_week,
      basis: r.basis,
      harvestReadyShare: r.harvest_ready_share,
      createdAt: r.created_at,
    }))
    const ctx: TimelineContext = {
      currentYw: today.year * 100 + today.week,
      sampling: samplingRows,
      breakerOnly: (y, w) => basisAt(settings, weekIndex(y, w), Number.POSITIVE_INFINITY, 'lifecycle').basis === 'breaker_only',
      flagged: flags.data ?? new Map(),
    }
    return new Map(shownWeeks.map((w) => [w.iso_week, cohortDetail(cohorts.data!, year, w.iso_week, w.sets_per_m2, ctx)]))
  })()
  const expandKey = (week: number) => `${crop?.id}:${year}:${week}`
  const toggleCohort = (week: number) => setExpanded((cur) => (cur === expandKey(week) ? null : expandKey(week)))
  const draftKey = (week: number) => `${crop?.id}:${year}:${week}`
  const savedAfw = (week: number) => afw.data?.get(week) ?? null
  const afwText = (week: number) => drafts[draftKey(week)] ?? (savedAfw(week) === null ? '' : String(savedAfw(week)))
  // What Picked kg uses: the typed value as soon as it's valid, else the saved one.
  const afwValue = (week: number) => {
    const parsed = parseAfw(afwText(week))
    return parsed === 'invalid' ? savedAfw(week) : parsed
  }
  const changes: AfwChange[] = []
  let invalid = 0
  for (const w of shownWeeks) {
    const text = drafts[draftKey(w.iso_week)]
    if (text === undefined) continue
    const parsed = parseAfw(text)
    if (parsed === 'invalid') invalid++
    else if (parsed !== savedAfw(w.iso_week)) changes.push({ week: w.iso_week, afwG: parsed })
  }
  const unsaved = changes.length + invalid > 0
  useEffect(() => {
    if (!unsaved) return
    const warn = (e: BeforeUnloadEvent) => e.preventDefault()
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [unsaved])
  const editAfw = (week: number, text: string) => {
    setJustSaved(false)
    setDrafts((d) => ({ ...d, [draftKey(week)]: text }))
  }
  const discardAfw = () => setDrafts((d) => Object.fromEntries(Object.entries(d).filter(([k]) => !k.startsWith(`${crop?.id}:${year}:`))))
  const save = () =>
    saveAfw.mutate(changes, {
      onSuccess: () => {
        discardAfw()
        setJustSaved(true)
      },
    })
  // Enter / Tab move down the AFW column (Shift goes up), so a season can be typed in one pass.
  const moveAfw = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter' && e.key !== 'Tab') return
    const inputs = [...(tableRef.current?.querySelectorAll<HTMLInputElement>('input[data-afw]') ?? [])]
    const next = inputs[inputs.indexOf(e.currentTarget) + (e.shiftKey ? -1 : 1)]
    if (!next) return
    e.preventDefault()
    next.focus()
    next.select()
  }


  const select = (next: { crop?: string; year?: number }) => {
    if (unsaved && !window.confirm('You have unsaved AFW changes. Discard them?')) return
    discardAfw()
    setJustSaved(false)
    setParams(
      (prev) => {
        const p = new URLSearchParams(prev)
        if (next.crop) {
          p.set('crop', next.crop)
          p.delete('year')
        }
        if (next.year) p.set('year', String(next.year))
        return p
      },
      { replace: true },
    )
  }

  if (crops.isPending) return <LoadingState />
  if (crops.error) return <ErrorState error={crops.error} />
  if (!crop || !year) {
    return <EmptyState title="No varieties yet" description="Add a variety in Settings, then record plants with the mobile collector." />
  }

  return (
    <section className={styles.section} aria-label="Weekly Plant Data">
      {/* One compact toolbar: tab on the left, Variety/Year centred, actions on the right. */}
      <div className={styles.toolbar}>
        <ProjectionsTabs />
        <div className={styles.selectors}>
          <label className={`field ${styles.control}`}>
            <span className="field-label">Variety</span>
            <select className="input" value={crop.id} onChange={(e) => select({ crop: e.target.value })}>
              {sorted.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <label className={`field ${styles.yearControl}`}>
            <span className="field-label">Year</span>
            <select className="input" value={year} onChange={(e) => select({ year: Number(e.target.value) })}>
              {years.map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className={styles.controlButtons}>
          <button
            type="button"
            className={`button button-secondary ${styles.helpButton}`}
            onClick={() => setShowSampling(true)}
            disabled={shownWeeks.length === 0}
            aria-haspopup="dialog"
          >
            Sampling detail
          </button>
          <button type="button" className={`button button-secondary ${styles.helpButton}`} onClick={() => setShowHelp(true)} aria-haspopup="dialog">
            <span className={styles.helpIcon} aria-hidden="true">?</span>
            Help
          </button>
        </div>
      </div>
      <SamplingDetail
        open={showSampling}
        onClose={() => setShowSampling(false)}
        year={year}
        weeks={shownWeeks}
        cohortRows={cohorts.data ?? []}
        samplingRows={samplingRows}
        ages={ages}
        stemsPerM2={stemsPerM2(crop)}
      />
      <WeeklyPlantDataHelp
        open={showHelp}
        onClose={() => setShowHelp(false)}
        stemsPerM2={stemsPerM2(crop)}
        areaM2={crop.area_m2}
        hiddenAges={hiddenAges.length < LADDER_AGES.length ? hiddenAges : []}
        startMarker={ages.includes(0)}
      />

      {weeks.isPending || cohorts.isPending || fruitLoss.isPending || sampling.isPending ? (
        <LoadingState />
      ) : weeks.error || cohorts.error || fruitLoss.error || sampling.error ? (
        <ErrorState error={weeks.error ?? cohorts.error ?? fruitLoss.error ?? sampling.error} />
      ) : shownWeeks.length === 0 ? (
        <EmptyState title={`No plant data for ${crop.name} in ${year}`} description="Weeks appear here once plants are recorded with the mobile collector." />
      ) : (
        <>
        <div className={styles.captionRow}>
          <div className={styles.caption}>
            <span className={styles.captionHint}>Click a week’s Sets/m² or Cohort bar to follow that week’s fruit through harvest.</span>
          </div>
          <div className={styles.afwBar} aria-live="polite">
            {saveAfw.error && <span className={styles.afwError}>Couldn’t save AFW: {saveAfw.error.message}</span>}
            {invalid > 0 && <span className={styles.afwError}>{invalid} AFW {invalid === 1 ? 'value isn’t' : 'values aren’t'} a weight in grams (0.1–{AFW_MAX_G}).</span>}
            {unsaved ? (
              <>
                <span className={styles.afwUnsaved}>
                  {changes.length} unsaved AFW change{changes.length === 1 ? '' : 's'}
                </span>
                <button type="button" className="button button-secondary" onClick={discardAfw} disabled={saveAfw.isPending}>
                  Discard
                </button>
                <button type="button" className="button button-primary" onClick={save} disabled={saveAfw.isPending || invalid > 0 || changes.length === 0}>
                  {saveAfw.isPending ? 'Saving…' : 'Save AFW'}
                </button>
              </>
            ) : (
              justSaved && <span className={styles.afwSaved}>AFW saved ✓</span>
            )}
          </div>
        </div>
        <div ref={tableRef} className={styles.tableWrap} onKeyDown={(e) => e.key === 'Escape' && setExpanded(null)}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">Week</th>
                <th scope="col" className={styles.stemsHead} title="Sampled stems visited that week ÷ stems in the sample">Stems</th>
                <th scope="col">Sets/m²</th>
                <th scope="col" className={styles.cohortHead} title="What became of the peppers set that week: harvested · aborted · pruned · unresolved · still on plant. Click for details.">
                  Cohort
                </th>
                <th scope="col">Breakers/m²</th>
                <th scope="col">Harvested/m²</th>
                <th scope="col" className={styles.afwHead} title="Harvest-week AFW: average grams per pepper harvested that week">AFW g</th>
                <th scope="col" className={styles.pickedHead} title="Estimated kg picked that calendar week: Harvested/m² × crop area × that week's AFW">Picked kg</th>
                <th scope="col" title="Peppers marked Harvestable that week in the collector (each counted once). This week only; never added to later weeks.">Harvestable</th>
                <th scope="col" title="Harvestable peppers ÷ sampled m² (a week still in progress uses the last sampled week's area)">Harvestable/m²</th>
                <th scope="col" title="Estimated kg of the Harvestable peppers that week: Harvestable/m² × crop area × AFW">Harvestable kg</th>
                <th scope="col" className={styles.actualHead} title="Actual kilograms harvested that week, entered by hand (click to enter or correct; every entry is kept)">Actual kg</th>
                <th scope="col" className={styles.lossHead} title="Fruit lost that calendar week ÷ fruit on the plants at the start of the week">Fruit Loss %</th>
              </tr>
            </thead>
            <tbody>
              {shownWeeks.map((w) => {
                const detail = details.get(w.iso_week) ?? null
                const open = expanded === expandKey(w.iso_week)
                return (
                <Fragment key={w.iso_week}>
                <tr className={[w.is_sampled ? '' : styles.unsampled, open ? styles.cohortOpenRow : ''].filter(Boolean).join(' ') || undefined}>
                  <th scope="row">
                    <span className={styles.week}>W{w.iso_week}</span>
                    {w.is_baseline && <span className={styles.tag}>Baseline</span>}
                    {w.is_provisional && <span className={`${styles.tag} ${styles.provisional}`}>In progress</span>}
                  </th>
                  <CoverageTd week={w.iso_week} row={samplingRows.get(w.iso_week)} />
                  <td>
                    {detail && detail.sets > 0 ? (
                      <button type="button" className={styles.setsButton} onClick={() => toggleCohort(w.iso_week)} aria-expanded={open} title={`Follow the W${w.iso_week} cohort (${detail.sets} sets)`}>
                        {formatRate(w.sets_per_m2)}
                      </button>
                    ) : (
                      formatRate(w.sets_per_m2)
                    )}
                  </td>
                  <td className={styles.cohortCell}>
                    <CohortBar detail={detail} open={open} onToggle={() => toggleCohort(w.iso_week)} />
                  </td>
                  <td>{formatRate(w.breakers_per_m2)}</td>
                  <td>{formatRate(w.harvested_per_m2)}</td>
                  <td className={styles.afwCell}>
                    <input
                      data-afw
                      className={[styles.afwInput, drafts[draftKey(w.iso_week)] !== undefined && parseAfw(afwText(w.iso_week)) !== savedAfw(w.iso_week) ? styles.afwDirty : ''].join(' ')}
                      inputMode="decimal"
                      value={afwText(w.iso_week)}
                      placeholder="—"
                      aria-label={`AFW W${w.iso_week} (average grams per pepper harvested that week)`}
                      aria-invalid={parseAfw(afwText(w.iso_week)) === 'invalid'}
                      onChange={(e) => editAfw(w.iso_week, e.target.value)}
                      onKeyDown={moveAfw}
                      onFocus={(e) => e.currentTarget.select()}
                    />
                  </td>
                  <PickedTd
                    week={w.iso_week}
                    harvestedPerM2={w.harvested_per_m2}
                    afwG={afwValue(w.iso_week)}
                    areaM2={crop.area_m2}
                    timing={weekTiming(year, w.iso_week, today)}
                  />
                  {(() => {
                    const row = harvestable.data?.get(w.iso_week)
                    if (!row) return <><td>—</td><td>—</td><td>—</td></>
                    const h = harvestableWeek(row, weeks.data ?? [], afwValue, crop.area_m2)
                    const picked = pickedKg(w.harvested_per_m2, afwValue(w.iso_week), crop.area_m2)
                    return (
                      <>
                        <td title={`${h.marked} marked Harvestable in W${h.week}: ${h.harvested} since recorded Harvested, ${h.remaining} still to pick`}>
                          {formatInteger(h.marked)}
                          {h.harvested > 0 && <span className={styles.tag}>{h.harvested} picked</span>}
                        </td>
                        <td>{formatRate(h.perM2)}</td>
                        <td title={harvestableKgTitle(h, crop.area_m2, picked)}>{h.kg === null ? '—' : formatInteger(Math.round(h.kg))}</td>
                      </>
                    )
                  })()}
                  <ActualTd week={w.iso_week} actual={actuals.data?.get(w.iso_week)} onOpen={() => setActualWeek(w.iso_week)} />
                  <FruitLossTd week={w.iso_week} row={fruitLossRows.get(w.iso_week)} />
                </tr>
                {open && detail && (
                  <tr className={styles.cohortDetailRow}>
                    <td colSpan={13}>
                      <CohortDetailPanel detail={detail} afwOf={(week) => afwValue(week)} areaM2={crop.area_m2} />
                    </td>
                  </tr>
                )}
                </Fragment>
                )
              })}
            </tbody>
          </table>
        </div>
        </>
      )}
      {actualWeek !== null && crop && year !== undefined && (
        <ActualDialogHost
          key={`${crop.id}:${year}:${actualWeek}`}
          organizationId={organization.id}
          cropId={crop.id}
          cropName={crop.name}
          year={year}
          week={actualWeek}
          actual={actuals.data?.get(actualWeek)}
          onClose={() => setActualWeek(null)}
        />
      )}
    </section>
  )
}

function ActualDialogHost(props: { organizationId: string; cropId: string; cropName: string; year: number; week: number; actual: ActualWeek | undefined; onClose: () => void }) {
  const save = useSaveWeeklyHarvestActual(props.organizationId, props.cropId, props.year)
  return (
    <ActualDialog
      cropName={props.cropName}
      year={props.year}
      week={props.week}
      actual={props.actual}
      saving={save.isPending}
      error={save.error ? save.error.message : null}
      onClose={props.onClose}
      onSave={(kg, note) => save.mutate({ week: props.week, kg, note }, { onSuccess: props.onClose })}
    />
  )
}

/** The actual kg in effect for a week; opens the entry dialog. */
function ActualTd({ week, actual, onOpen }: { week: number; actual: ActualWeek | undefined; onOpen: () => void }) {
  const corrected = (actual?.history.length ?? 0) > 1
  return (
    <td className={styles.actualCell}>
      <button
        type="button"
        className={styles.actualButton}
        onClick={onOpen}
        aria-label={`Actual harvested kg W${week}${actual?.kg != null ? `: ${formatInteger(Math.round(actual.kg))} kg` : ': not entered'}`}
        title={actual?.history.length ? `${actual.history.length} entr${actual.history.length === 1 ? 'y' : 'ies'}; click for the history` : 'Enter the actual kg harvested'}
      >
        {actual?.kg != null ? formatInteger(Math.round(actual.kg)) : '+'}
        {corrected && <span className={styles.actualCorrected} aria-hidden="true">✎</span>}
      </button>
    </td>
  )
}

/** Enter, correct or clear one week's actual harvested kg; every earlier entry stays listed. */
function ActualDialog({
  cropName,
  year,
  week,
  actual,
  onSave,
  onClose,
  saving,
  error,
}: {
  cropName: string
  year: number
  week: number
  actual: ActualWeek | undefined
  onSave: (kg: number | null, note: string | null) => void
  onClose: () => void
  saving: boolean
  error: string | null
}) {
  const [text, setText] = useState(actual?.kg == null ? '' : String(actual.kg))
  const [note, setNote] = useState('')
  const parsed = parseActualKg(text)
  const unchanged = parsed === (actual?.kg ?? null) && note.trim() === ''
  const when = (iso: string) => new Date(iso).toLocaleString(undefined, { timeZone: 'America/Toronto', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
  return (
    <Dialog open title={`Actual harvested kg · ${cropName} · W${week} ${year}`} onClose={onClose}>
      <form
        className={styles.actualForm}
        onSubmit={(e) => {
          e.preventDefault()
          if (parsed === 'invalid' || unchanged) return
          onSave(parsed, note.trim() || null)
        }}
      >
        <p className={styles.actualHint}>
          The kilograms actually harvested for this variety in W{week}, from your harvest records. Forecasts are scored against it. Leave it empty and save to
          clear the week. Earlier entries are kept.
        </p>
        <label className="field">
          <span className="field-label">Actual kg</span>
          <input className="input" inputMode="decimal" value={text} onChange={(e) => setText(e.target.value)} autoFocus aria-invalid={parsed === 'invalid'} placeholder="e.g. 54000" />
        </label>
        <label className="field">
          <span className="field-label">Note (optional)</span>
          <input className="input" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder={actual?.history.length ? 'Why it was corrected' : ''} />
        </label>
        {parsed === 'invalid' && <p className={styles.afwError}>Enter kilograms as a number (up to 2 decimals).</p>}
        {error && <p className={styles.afwError}>{error}</p>}
        <div className={styles.actualActions}>
          <button type="submit" className="button button-primary" disabled={saving || parsed === 'invalid' || unchanged}>
            {saving ? 'Saving…' : parsed === null && actual?.kg != null ? 'Clear the week' : 'Save'}
          </button>
          <button type="button" className="button button-secondary" onClick={onClose} disabled={saving}>
            Cancel
          </button>
        </div>
      </form>
      {actual && actual.history.length > 0 && (
        <div className={styles.actualHistory}>
          <h3>History</h3>
          <ol>
            {actual.history.map((h, i) => (
              <li key={h.id}>
                <strong>{h.kg === null ? 'Cleared' : `${formatInteger(Math.round(h.kg))} kg`}</strong> · {when(h.enteredAt)}
                {i === 0 && <span className={styles.tag}>In effect</span>}
                {h.note && <span className={styles.actualNote}> — {h.note}</span>}
              </li>
            ))}
          </ol>
        </div>
      )}
    </Dialog>
  )
}

const COVERAGE_CLASS = { none: '', full: '', partial: styles.coveragePartial, in_progress: styles.coverageInProgress }

/** Stems visited ÷ stems in the sample. Partial weeks stand out; legacy weeks (visits inferred from records) are muted. */
function CoverageTd({ week, row }: { week: number; row: SamplingWeekRow | undefined }) {
  const kind = row ? coverageKind(row) : 'none'
  const classes = [styles.coverage, COVERAGE_CLASS[kind], row?.tracking === 'legacy' && kind !== 'none' ? styles.coverageLegacy : ''].filter(Boolean).join(' ')
  return (
    <td className={classes} title={coverageTitle(week, row)}>
      {coverageLabel(row)}
      {row?.state === 'complete' && <span className={styles.coverageComplete} aria-label="sampling marked complete"> ✓</span>}
    </td>
  )
}

const TIMING_CLASS: Record<WeekTiming, string> = { past: styles.pickedPast, current: styles.pickedCurrent, future: styles.pickedFuture }

/** Kg picked in the row's calendar week: its Harvested/m² × that week's AFW, for the whole crop area. Shaded by calendar week only. */
function PickedTd({ week, harvestedPerM2, afwG, areaM2, timing }: { week: number; harvestedPerM2: number | null; afwG: number | null; areaM2: number; timing: WeekTiming }) {
  const kg = pickedKg(harvestedPerM2, afwG, areaM2)
  return (
    <td className={[styles.pickedCell, TIMING_CLASS[timing]].join(' ')} title={pickedKgTitle(week, harvestedPerM2, afwG, areaM2, kg, timing === 'current')}>
      {kg === null ? '—' : formatInteger(Math.round(kg))}
    </td>
  )
}

/** Fruit lost in the row's calendar week ÷ fruit on the plant at its start. Not part of any cohort, so never highlighted. */
function FruitLossTd({ week, row }: { week: number; row: WeeklyFruitLossRow | undefined }) {
  return (
    <td className={[styles.lossCell, row?.is_provisional ? styles.incomplete : ''].filter(Boolean).join(' ')} title={fruitLossTitle(week, row)}>
      {formatFruitLoss(row)}
    </td>
  )
}
