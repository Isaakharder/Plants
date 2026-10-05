import { useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { EmptyState, ErrorState, LoadingState } from '../../components/States'
import { formatInteger, formatTwoDecimals } from '../../lib/format'
import { greenhouseIsoWeek } from '../collector/greenhouseWeek'
import { useCrops } from '../crops/api'
import { sortCrops, stemsPerM2 } from '../crops/model'
import { useOrganization } from '../organization/OrganizationProvider'
import { useSetHarvestCohorts, useWeeklyPlantData } from './api'
import {
  LADDER_AGES,
  cellAtAge,
  cohortBand,
  cohortCellTitle,
  cohortKey,
  cropYears,
  defaultYear,
  followCaption,
  formatLoss,
  formatPercent,
  formatRate,
  ladderAgesWithHarvests,
  lossTitle,
  summarize,
  weeksFromFirstSample,
  type CohortCell,
  type CohortSummary,
  type SetHarvestCohortRow,
} from './model'
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
  const [showDetail, setShowDetail] = useState(false)
  // The followed cohort: a click locks it, hovering previews one while nothing is locked.
  const [locked, setLocked] = useState<string | null>(null)
  const [hovered, setHovered] = useState<string | null>(null)

  const sorted = useMemo(() => sortCrops(crops.data ?? []), [crops.data])
  const crop = sorted.find((c) => c.id === params.get('crop')) ?? sorted[0]
  const years = crop ? cropYears(crop) : []
  const requestedYear = Number(params.get('year'))
  const year = years.includes(requestedYear) ? requestedYear : years.length ? defaultYear(years, greenhouseIsoWeek().year) : undefined

  const weeks = useWeeklyPlantData(crop?.id, year)
  const cohorts = useSetHarvestCohorts(crop?.id, year)
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
  const active = locked ?? hovered
  const follow = {
    active,
    preview: (key: string | null) => setHovered(key),
    toggle: (key: string) => setLocked((current) => (current === key ? null : key)),
  }

  const select = (next: { crop?: string; year?: number }) =>
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
        <label className={styles.detailToggle}>
          <input type="checkbox" checked={showDetail} onChange={(e) => setShowDetail(e.target.checked)} />
          Show sampling detail
        </label>
      </div>

      <p className={styles.explainer}>
        Peppers on the sampled plants that entered each stage that week, per sampled m². Each pepper counts once per
        stage, in the first week it was recorded there. Sampled m² = sampled stems ÷ {formatTwoDecimals(stemsPerM2(crop))} stems/m².{' '}
        <strong>+0 … +10</strong>: every set week starts its own cohort at +0 and moves one row down and one column right each
        week; a cell is the share of that original cohort first harvested at exactly that age. <strong>Loss</strong>: aborted,
        pruned and unresolved-after-+10 peppers of the cohort whose window closes that week (a first harvest at +11 or later is outside the window). Click a week's Sets/m² to
        follow its cohort.{hiddenAges.length > 0 && hiddenAges.length < LADDER_AGES.length && (
          <> Ages with no harvests in this year are hidden ({hiddenAges.map((a) => `+${a}`).join(', ')}).</>
        )}
      </p>

      {/* Above the table: nothing follows the table on the page, so its frozen header can't scroll under the top bar. */}
      <dl className={styles.legend}>
        <div>
          <dt>—</dt>
          <dd>Not sampled that week.</dd>
        </div>
        <div>
          <dt><span className={styles.tag}>Baseline</span></dt>
          <dd>First sampling week. There was no earlier visit, so it can include stages reached before sampling began.</dd>
        </div>
        <div>
          <dt>Sets/m²</dt>
          <dd>
            Click a week's Sets/m²{ages.includes(0) && <> (or its <span className={styles.startSample}>●</span> at +0)</>} to highlight that cohort's ladder; click again or press
            Esc to release.
          </dd>
        </div>
        <div>
          <dt><span className={styles.baselineSample}>12.3%</span></dt>
          <dd>From the baseline set cohort. Those peppers may have set before sampling began, so their real set → harvest delay may be longer.</dd>
        </div>
        <div>
          <dt>Loss</dt>
          <dd>Shown when a cohort's +10 window closes: aborted + pruned + timeout (not harvested by +10; a Harvested record at +11 or later still counts in Harvested/m²). — while the window is open.</dd>
        </div>
        <div>
          <dt><span className={`${styles.tag} ${styles.provisional}`}>In progress</span></dt>
          <dd>The current greenhouse week. Sampling may not be complete, so its values can still change.</dd>
        </div>
      </dl>
      {weeks.isPending || cohorts.isPending ? (
        <LoadingState />
      ) : weeks.error || cohorts.error ? (
        <ErrorState error={weeks.error ?? cohorts.error} />
      ) : shownWeeks.length === 0 ? (
        <EmptyState title={`No plant data for ${crop.name} in ${year}`} description="Weeks appear here once plants are recorded with the mobile collector." />
      ) : (
        <>
        <FollowCaption summary={active ? summaries.get(active) : undefined} year={year} locked={locked !== null} onClear={() => setLocked(null)} />
        <div className={styles.tableWrap} onKeyDown={(e) => e.key === 'Escape' && setLocked(null)}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">Week</th>
                <th scope="col">Sets/m²</th>
                <th scope="col">Breakers/m²</th>
                <th scope="col">Harvested/m²</th>
                {ages.map((d, i) => (
                  <th key={d} scope="col" className={i === 0 ? styles.firstDelay : undefined}>
                    +{d}
                  </th>
                ))}
                <th scope="col" className={styles.lossHead}>Loss</th>
                {showDetail && (
                  <>
                    <th scope="col" className={styles.detail}>Sampled stems</th>
                    <th scope="col" className={styles.detail}>Sampled m²</th>
                    <th scope="col" className={styles.detail}>New sets</th>
                    <th scope="col" className={styles.detail}>New breakers</th>
                    <th scope="col" className={styles.detail}>Harvested</th>
                  </>
                )}
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
                    <CohortTd key={d} cell={cellAtAge(cohortRows.get(w.iso_week), d)} year={year} week={w.iso_week} showDetail={showDetail} divider={i === 0} follow={follow} />
                  ))}
                  <LossTd row={cohortRows.get(w.iso_week)} year={year} follow={follow} />
                  {showDetail && (
                    <>
                      <td className={styles.detail}>{w.is_sampled ? formatInteger(w.sampled_stems) : '—'}</td>
                      <td className={styles.detail}>{w.sampled_m2 === null ? '—' : formatTwoDecimals(w.sampled_m2)}</td>
                      <td className={styles.detail}>{w.is_sampled ? formatInteger(w.new_sets) : '—'}</td>
                      <td className={styles.detail}>{w.is_sampled ? formatInteger(w.new_breakers) : '—'}</td>
                      <td className={styles.detail}>{w.is_sampled ? formatInteger(w.new_harvested) : '—'}</td>
                    </>
                  )}
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

function CohortTd({ cell, year, week, showDetail, divider, follow }: { cell: CohortCell | undefined; year: number; week: number; showDetail: boolean; divider: boolean; follow: Follow }) {
  // The cohort's start (+0) shows a marker instead of a percentage.
  const first = cell?.delay === 0
  if (!cell || cell.cohort_sets === 0) return <td className={divider ? styles.firstDelay : undefined}>—</td>
  const key = cohortKey(cell.set_year, cell.set_week)
  const classes = [
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
        {showDetail && <span className={styles.cellDetail}>{cell.cohort_sets} set</span>}
      </td>
    )
  }
  return (
    <td className={classes} title={cohortCellTitle(cell, year, week)} {...followHandlers(key, follow)}>
      <span className={[cell.percent === 0 ? styles.zero : '', cell.is_baseline_cohort && cell.percent !== null ? styles.baselineCell : ''].filter(Boolean).join(' ') || undefined}>
        {formatPercent(cell.percent)}
      </span>
      {showDetail && cell.percent !== null && (
        <span className={styles.cellDetail}>
          {cell.harvested}/{cell.cohort_sets}
        </span>
      )}
    </td>
  )
}

/** Loss of the cohort whose +10 window closes in this row's week (the end of its ladder). */
function LossTd({ row, year, follow }: { row: SetHarvestCohortRow | undefined; year: number; follow: Follow }) {
  const closing = row?.closing
  if (!closing || closing.sets === 0) return <td className={styles.lossCell}>—</td>
  const key = cohortKey(closing.set_year, closing.set_week)
  const classes = [styles.lossCell, BAND_CLASS[cohortBand(closing.set_year, closing.set_week)], follow.active === key ? styles.ladderActive : ''].join(' ')
  return (
    <td className={classes} title={lossTitle(closing, year)} {...followHandlers(key, follow)}>
      <span className={closing.is_baseline_cohort && closing.closed ? styles.baselineCell : undefined}>{formatLoss(closing)}</span>
    </td>
  )
}
