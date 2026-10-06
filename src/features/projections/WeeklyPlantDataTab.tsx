import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { useSearchParams } from 'react-router-dom'
import { EmptyState, ErrorState, LoadingState } from '../../components/States'
import { formatInteger } from '../../lib/format'
import { greenhouseIsoWeek, useGreenhouseWeek } from '../collector/greenhouseWeek'
import { useCrops } from '../crops/api'
import { sortCrops, stemsPerM2 } from '../crops/model'
import { useOrganization } from '../organization/OrganizationProvider'
import { useSaveWeeklyHarvestAfw, useSetHarvestCohorts, useWeeklyFruitLoss, useWeeklyHarvestAfw, useWeeklyPlantData, type AfwChange } from './api'
import {
  LADDER_AGES,
  AFW_MAX_G,
  cellAtAge,
  cohortBand,
  cohortCellTitle,
  cohortKey,
  cropYears,
  defaultYear,
  followCaption,
  formatCohortPercent,
  formatFruitLoss,
  fruitLossTitle,
  formatRate,
  ladderAgesWithHarvests,
  parseAfw,
  pickedKg,
  pickedKgTitle,
  summarize,
  weekTiming,
  weeksFromFirstSample,
  type CohortCell,
  type CohortSummary,
  type SetHarvestCohortRow,
  type WeeklyFruitLossRow,
  type WeekTiming,
} from './model'
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
  // The followed cohort: a click locks it, hovering previews one while nothing is locked.
  const [locked, setLocked] = useState<string | null>(null)
  const [hovered, setHovered] = useState<string | null>(null)
  const today = useGreenhouseWeek()

  const sorted = useMemo(() => sortCrops(crops.data ?? []), [crops.data])
  const crop = sorted.find((c) => c.id === params.get('crop')) ?? sorted[0]
  const years = crop ? cropYears(crop) : []
  const requestedYear = Number(params.get('year'))
  const year = years.includes(requestedYear) ? requestedYear : years.length ? defaultYear(years, greenhouseIsoWeek().year) : undefined

  const weeks = useWeeklyPlantData(crop?.id, year)
  const cohorts = useSetHarvestCohorts(crop?.id, year)
  const fruitLoss = useWeeklyFruitLoss(crop?.id, year)
  const afw = useWeeklyHarvestAfw(crop?.id, year)
  const saveAfw = useSaveWeeklyHarvestAfw(organization.id, crop?.id, year)
  // Typed but unsaved AFWs, per crop · year · harvest week (text as typed).
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [justSaved, setJustSaved] = useState(false)
  const tableRef = useRef<HTMLDivElement>(null)
  const fruitLossRows = useMemo(() => new Map((fruitLoss.data ?? []).map((row) => [row.iso_week, row])), [fruitLoss.data])
  const cohortRows = useMemo(() => new Map((cohorts.data ?? []).map((row) => [row.iso_week, row])), [cohorts.data])
  // Presentation only: start at the first sampled week and show only the
  // cohort ages that have a harvest somewhere in the displayed weeks.
  const shownWeeks = useMemo(() => weeksFromFirstSample(weeks.data ?? []), [weeks.data])
  const ages = useMemo(
    () => ladderAgesWithHarvests(shownWeeks.flatMap((w) => cohortRows.get(w.iso_week) ?? [])),
    [shownWeeks, cohortRows],
  )
  const hiddenAges = LADDER_AGES.filter((age) => !ages.includes(age))
  // Every cell of a cohort carries the same summary; keep one per cohort for the caption.
  const summaries = useMemo(() => {
    const byKey = new Map<string, CohortSummary>()
    for (const row of cohorts.data ?? []) for (const cell of row.cells) byKey.set(cohortKey(cell.set_year, cell.set_week), summarize(cell))
    return byKey
  }, [cohorts.data])
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

  const active = locked ?? hovered
  const follow = {
    active,
    preview: (key: string | null) => setHovered(key),
    toggle: (key: string) => setLocked((current) => (current === key ? null : key)),
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
      <div className={styles.controls}>
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

      {weeks.isPending || cohorts.isPending || fruitLoss.isPending ? (
        <LoadingState />
      ) : weeks.error || cohorts.error || fruitLoss.error ? (
        <ErrorState error={weeks.error ?? cohorts.error ?? fruitLoss.error} />
      ) : shownWeeks.length === 0 ? (
        <EmptyState title={`No plant data for ${crop.name} in ${year}`} description="Weeks appear here once plants are recorded with the mobile collector." />
      ) : (
        <>
        <div className={styles.captionRow}>
          <FollowCaption summary={active ? summaries.get(active) : undefined} year={year} locked={locked !== null} onClear={() => setLocked(null)} />
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
        <div ref={tableRef} className={styles.tableWrap} onKeyDown={(e) => e.key === 'Escape' && setLocked(null)}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">Week</th>
                <th scope="col">Sets/m²</th>
                <th scope="col">Breakers/m²</th>
                <th scope="col">Harvested/m²</th>
                {ages.map((d, i) => (
                  <th key={d} scope="col" className={[styles.age, i === 0 ? styles.firstDelay : ''].filter(Boolean).join(' ')}>
                    +{d}
                  </th>
                ))}
                <th scope="col" className={styles.afwHead} title="Harvest-week AFW: average grams per pepper harvested that week">AFW g</th>
                <th scope="col" className={styles.pickedHead} title="Estimated kg picked that calendar week: Harvested/m² × crop area × that week's AFW">Picked kg</th>
                <th scope="col" className={styles.lossHead} title="Fruit lost that calendar week ÷ fruit on the plants at the start of the week">Fruit Loss %</th>
              </tr>
            </thead>
            <tbody>
              {shownWeeks.map((w) => (
                <tr key={w.iso_week} className={w.is_sampled ? undefined : styles.unsampled}>
                  <th scope="row">
                    <span className={styles.week}>W{w.iso_week}</span>
                    {w.is_baseline && <span className={styles.tag}>Baseline</span>}
                    {w.is_provisional && <span className={`${styles.tag} ${styles.provisional}`}>In progress</span>}
                  </th>
                  <SetsTd row={cohortRows.get(w.iso_week)} value={formatRate(w.sets_per_m2)} follow={follow} />
                  <td>{formatRate(w.breakers_per_m2)}</td>
                  <td>{formatRate(w.harvested_per_m2)}</td>
                  {ages.map((d, i) => (
                    <CohortTd key={d} cell={cellAtAge(cohortRows.get(w.iso_week), d)} year={year} week={w.iso_week} divider={i === 0} follow={follow} />
                  ))}
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
                  <FruitLossTd week={w.iso_week} row={fruitLossRows.get(w.iso_week)} />
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        </>
      )}

    </section>
  )
}

const BAND_CLASS = [styles.band0, styles.band1, styles.band2]

type Follow = { active: string | null; preview: (key: string | null) => void; toggle: (key: string) => void }

/** Hover previews a cohort, click locks it. */
function followHandlers(key: string, follow: Follow) {
  return {
    onMouseEnter: () => follow.preview(key),
    onMouseLeave: () => follow.preview(null),
    onClick: () => follow.toggle(key),
  }
}

function FollowCaption({ summary, year, locked, onClear }: { summary: CohortSummary | undefined; year: number; locked: boolean; onClear: () => void }) {
  return (
    <div className={styles.caption} aria-live="polite">
      {summary ? (
        <>
          <span>{followCaption(summary, year)}</span>
          {locked && (
            <button type="button" className="button button-link" onClick={onClear}>
              Clear
            </button>
          )}
        </>
      ) : (
        <span className={styles.captionHint}>Click a week’s Sets/m² to follow that cohort down the table.</span>
      )}
    </div>
  )
}

/** Sets/m² starts the row's own cohort: clicking it follows that cohort. */
function SetsTd({ row, value, follow }: { row: SetHarvestCohortRow | undefined; value: string; follow: Follow }) {
  const start = row?.cells[0]
  if (!start || start.cohort_sets === 0) return <td>{value}</td>
  const key = cohortKey(start.set_year, start.set_week)
  return (
    <td className={follow.active === key ? styles.ladderActive : undefined}>
      <button type="button" className={styles.setsButton} title={`Follow the W${start.set_week} cohort (${start.cohort_sets} sets)`} aria-pressed={follow.active === key} {...followHandlers(key, follow)}>
        {value}
      </button>
    </td>
  )
}

function CohortTd({ cell, year, week, divider, follow }: { cell: CohortCell | undefined; year: number; week: number; divider: boolean; follow: Follow }) {
  // The cohort's start (+0) shows a marker instead of a percentage.
  const first = cell?.delay === 0
  if (!cell || cell.cohort_sets === 0) return <td className={[styles.age, divider ? styles.firstDelay : ''].filter(Boolean).join(' ')}>—</td>
  const key = cohortKey(cell.set_year, cell.set_week)
  const classes = [
    styles.age,
    divider ? styles.firstDelay : '',
    BAND_CLASS[cohortBand(cell.set_year, cell.set_week)],
    follow.active === key ? styles.ladderActive : '',
  ].filter(Boolean).join(' ')

  if (first) {
    return (
      <td className={classes}>
        <button type="button" className={styles.startMarker} title={cohortCellTitle(cell, year, week)} aria-pressed={follow.active === key} {...followHandlers(key, follow)}>
          ●
        </button>
      </td>
    )
  }
  return (
    <td className={classes} title={cohortCellTitle(cell, year, week)} {...followHandlers(key, follow)}>
      <span className={[cell.percent === 0 ? styles.zero : '', cell.is_baseline_cohort && cell.percent !== null ? styles.baselineCell : ''].filter(Boolean).join(' ') || undefined}>
        {formatCohortPercent(cell.percent)}
      </span>
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
