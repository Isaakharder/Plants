import { useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { EmptyState, ErrorState, LoadingState } from '../../components/States'
import { greenhouseIsoWeek } from '../collector/greenhouseWeek'
import { useCrops } from '../crops/api'
import { colorLabel, type Crop } from '../crops/model'
import { useOrganization } from '../organization/OrganizationProvider'
import { ProjectionsTabs } from '../projections/ProjectionsTabs'
import wpd from '../projections/WeeklyPlantDataTab.module.css'
import { useProductionHistory } from './api'
import {
  errorWord,
  formatError,
  GREENHOUSE_TZ,
  HORIZON_WEEKS,
  productionHistory,
  type Accuracy,
  type Cell,
  type HistoryCrop,
  type HistoryRow,
  type Phase,
  type VarietyWeek,
} from './productionHistory'
import fc from './HarvestForecastTab.module.css'
import styles from './ProductionTotalsTab.module.css'

const fmt = (n: number | null) => (n === null ? '—' : Math.round(n).toLocaleString('en-US'))
const swatch = (color: string) => `var(--pepper-${['red', 'orange', 'yellow', 'green'].includes(color) ? color : 'other'})`
const colourName = (color: string) => colorLabel(color as Crop['color'])
const savedLabel = (iso: string) =>
  new Date(iso).toLocaleString('en-CA', { timeZone: GREENHOUSE_TZ, weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })

const FORECAST_MISSING = {
  no_forecast: 'no forecast',
  saved_after_start: 'saved too late',
  not_available: 'not available',
  afw_needed: 'AFW needed',
} as const
const FORECAST_MISSING_LONG = {
  no_forecast: 'no forecast saved for this week',
  saved_after_start: 'only forecasts saved after the week began (not used)',
  not_available: 'its forecasts don’t cover this week',
  afw_needed: 'forecast has no kg (AFW needed)',
} as const
const ACTUAL_MISSING = { not_entered: 'not entered', in_progress: 'in progress', future: '' } as const
const KIND = { official: 'Official', late: 'Late', preliminary: 'Preliminary' } as const
const PHASE: Record<Phase, string> = { completed: 'Completed', current: 'This week', future: 'Future' }

type View = 'every' | 'all' | string

/**
 * Projections › Production Totals: the season's projected kg against actual
 * harvested kg, per week and pepper colour (productionHistory.ts).
 */
export function ProductionTotalsTab() {
  const organization = useOrganization()
  const crops = useCrops(organization.id)
  const [params, setParams] = useSearchParams()
  const today = greenhouseIsoWeek()
  const currentYw = today.year * 100 + today.week
  const [view, setView] = useState<View>(() => (typeof window !== 'undefined' && window.matchMedia?.('(max-width: 720px)').matches ? 'all' : 'every'))

  const all = useMemo(() => crops.data ?? [], [crops.data])
  const years = useMemo(() => {
    const ys = new Set<number>([today.year])
    for (const c of all) for (let y = Number(c.planting_date.slice(0, 4)); y <= Number(c.pullout_date.slice(0, 4)); y++) ys.add(y)
    return [...ys].sort((a, b) => b - a)
  }, [all, today.year])
  const year = years.includes(Number(params.get('year'))) ? Number(params.get('year')) : today.year

  const historyCrops: HistoryCrop[] = useMemo(
    () => all.map((c) => ({ id: c.id, name: c.name, color: c.color, plantingDate: c.planting_date, pulloutDate: c.pullout_date })),
    [all],
  )
  const data = useProductionHistory(historyCrops.map((c) => c.id), year)
  const page = useMemo(
    () => (data.data ? productionHistory(historyCrops, data.data.snapshots, data.data.actuals, year, currentYw) : null),
    [data.data, historyCrops, year, currentYw],
  )

  if (crops.isPending) return <LoadingState />
  if (crops.error) return <ErrorState error={crops.error} />
  if (all.length === 0) return <EmptyState title="No varieties yet" description="Add a variety in Settings." />

  const groups = page?.groups ?? []
  const shown = view === 'every' ? [...groups.map((g) => g.color), 'all'] : view === 'all' ? ['all'] : [view]
  const cellOf = (r: HistoryRow, key: string) => (key === 'all' ? r.all : r.byGroup.get(key)!)

  return (
    <section className={wpd.section} aria-label="Production Totals">
      <div className={wpd.toolbar}>
        <ProjectionsTabs />
        <div className={wpd.selectors}>
          <label className={`field ${wpd.yearControl}`}>
            <span className="field-label">Year</span>
            <select
              className="input"
              value={year}
              onChange={(e) => setParams((p) => { const n = new URLSearchParams(p); n.set('year', e.target.value); return n }, { replace: true })}
            >
              {years.map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      <p className={fc.subtitle}>
        The season’s projected harvest against the actual kg entered in Weekly Plant Data. Each week uses the forecast that was saved before the week began
        (the newest sampling week; a locked forecast over a preliminary one), never a recalculation. Error = (projected − actual) ÷ projected: positive
        means overestimated, negative underestimated. Missing values are shown as missing, never as zero.
      </p>

      {data.isPending ? (
        <LoadingState />
      ) : data.error ? (
        <ErrorState error={data.error} />
      ) : page && page.rows.length === 0 ? (
        <EmptyState title={`No forecasts or harvests for ${year}`} description="Weeks appear once a forecast is saved on Harvest Forecast or an actual kg is entered in Weekly Plant Data." />
      ) : page ? (
        <>
          <div className={styles.cards}>
            {groups.map((g) => (
              <AccuracyCard key={g.color} title={colourName(g.color)} color={g.color} varieties={g.crops.map((c) => c.name)} acc={page.accuracy.byGroup.get(g.color)!} year={year} />
            ))}
            <AccuracyCard title="All colours" color={null} varieties={[`${all.length} varieties`]} acc={page.accuracy.all} year={year} />
          </div>

          <div className={styles.viewBar} role="group" aria-label="Colours shown">
            {[['every', 'Every colour'], ...groups.map((g) => [g.color, colourName(g.color)]), ['all', 'All colours']].map(([key, label]) => (
              <button key={key} type="button" aria-pressed={view === key} className={styles.viewButton} onClick={() => setView(key)}>
                {label}
              </button>
            ))}
          </div>

          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th scope="col" rowSpan={2}>
                    Week
                  </th>
                  {shown.map((key) => (
                    <th key={key} scope="colgroup" colSpan={3} className={`${styles.colourHead} ${key === 'all' ? styles.allHead : ''}`}>
                      {key !== 'all' && <span className={styles.swatch} style={{ background: swatch(key) }} aria-hidden="true" />}
                      {key === 'all' ? 'All colours' : colourName(key)}
                    </th>
                  ))}
                </tr>
                <tr>
                  {shown.flatMap((key) => [
                    <th key={`${key}p`} scope="col" className={key === 'all' ? styles.allCol : undefined}>
                      Projected
                    </th>,
                    <th key={`${key}a`} scope="col" className={key === 'all' ? styles.allCol : undefined}>
                      Actual
                    </th>,
                    <th key={`${key}e`} scope="col" className={`${styles.groupEnd} ${key === 'all' ? styles.allCol : ''}`}>
                      Error
                    </th>,
                  ])}
                </tr>
              </thead>
              <tbody>
                {page.rows.map((r) => (
                  <tr key={r.yw} className={styles[`row_${r.phase}`]}>
                    <th scope="row">
                      <span className={styles.weekLabel}>W{r.yw % 100}</span>
                      <PhaseTag row={r} />
                    </th>
                    {shown.map((key) => (
                      <Cells key={key} cell={cellOf(r, key)} phase={r.phase} all={key === 'all'} />
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className={fc.fate}>
            <strong>Future</strong> weeks (up to {HORIZON_WEEKS} ahead) show the latest saved forecast, Official or Preliminary. <strong>This week</strong> shows the
            forecast saved before it began; its actual kg is still coming in. <strong>≥</strong> some varieties have no projected or actual kg that week (hover for
            which); the error then covers only the varieties with both. Accuracy counts completed weeks only. Forecasts are experimental until validated against
            actual kg.
          </p>
        </>
      ) : null}
    </section>
  )
}

function PhaseTag({ row }: { row: HistoryRow }) {
  if (row.phase !== 'future') return <span className={`${styles.phase} ${styles[`phase_${row.phase}`]}`}>{PHASE[row.phase]}</span>
  const kinds = row.all.kinds
  const label = kinds.size === 0 ? 'No forecast' : kinds.has('preliminary') ? (kinds.size > 1 ? 'Official + preliminary' : 'Preliminary') : 'Official'
  return <span className={`${styles.phase} ${styles.phase_future}`}>{`Future · ${label}`}</span>
}

function partTitle(p: VarietyWeek): string {
  const f = p.forecast
  const projected = f
    ? `${f.kg === null ? 'no kg (AFW needed)' : `${fmt(f.kg)} kg`}, ${KIND[f.kind]} from the W${f.originYw % 100} sampling, saved ${savedLabel(f.savedAt)}`
    : FORECAST_MISSING_LONG[p.forecastMissing!]
  const actual = p.actualKg !== null ? `${fmt(p.actualKg)} kg` : p.actualMissing === 'future' ? 'not yet' : ACTUAL_MISSING[p.actualMissing!]
  return `${p.crop.name}: projected ${projected} · actual ${actual}${p.matched ? '' : p.actualMissing === 'not_entered' || !f?.kg ? ' · not in accuracy' : ''}`
}

function Cells({ cell, phase, all }: { cell: Cell; phase: Phase; all: boolean }) {
  const cls = all ? styles.allCol : ''
  if (cell.expected === 0) {
    return (
      <>
        <td className={cls} title="No variety of this colour in season">·</td>
        <td className={cls} />
        <td className={`${cls} ${styles.groupEnd}`} />
      </>
    )
  }
  const title = cell.parts.map(partTitle).join('\n')
  const reasons = (list: string[]) => [...new Set(list)].join(', ')
  const projected =
    cell.projected === null ? (
      <span className={styles.missing}>{reasons(cell.parts.map((p) => (p.forecastMissing ? FORECAST_MISSING[p.forecastMissing] : '')).filter(Boolean))}</span>
    ) : (
      <>
        {cell.projectedComplete ? '' : <span className={styles.partialMark}>≥ </span>}
        {fmt(cell.projected)}
      </>
    )
  const actual =
    phase === 'future' ? (
      <span className={styles.notYet}>—</span>
    ) : cell.actual === null ? (
      <span className={styles.missing}>{phase === 'current' ? 'in progress' : 'not entered'}</span>
    ) : (
      <>
        {cell.actualComplete ? '' : <span className={styles.partialMark}>≥ </span>}
        {fmt(cell.actual)}
        {phase === 'current' && <span className={styles.soFar}> so far</span>}
      </>
    )
  const partialError = cell.errorPct !== null && cell.matchedCount < cell.expected
  const errTitle =
    cell.errorPct === null
      ? phase === 'completed'
        ? 'No variety has both a projected and an actual kg this week'
        : 'Counted once the week is over'
      : `${formatError(cell.errorPct)} (${errorWord(cell.errorPct)}) on ${cell.matchedCount} of ${cell.expected} varieties: ${fmt(cell.matchedProjected)} kg projected, ${fmt(cell.matchedActual)} kg actual`
  return (
    <>
      <td className={`${cls} ${cell.projectedComplete ? '' : styles.partial}`} title={title}>
        {projected}
      </td>
      <td className={`${cls} ${cell.actualComplete || phase === 'future' ? '' : styles.partial}`} title={title}>
        {actual}
      </td>
      <td className={`${cls} ${styles.groupEnd} ${cell.errorPct === null ? styles.notYet : cell.errorPct > 0 ? styles.over : styles.under}`} title={errTitle}>
        {formatError(cell.errorPct)}
        {partialError && <span className={styles.partialMark}>*</span>}
      </td>
    </>
  )
}

function AccuracyCard({ title, color, varieties, acc, year }: { title: string; color: string | null; varieties: string[]; acc: Accuracy; year: number }) {
  const vw = (n: number) => `${n} variety-week${n === 1 ? '' : 's'}`
  const excluded = [
    acc.excluded.forecast ? `${acc.excluded.forecast} without a forecast from before the week` : '',
    acc.excluded.actual ? `${acc.excluded.actual} without actual kg` : '',
  ].filter(Boolean)
  return (
    <article className={`${styles.card} ${color === null ? styles.allCard : ''}`}>
      <header className={styles.cardHead}>
        {color !== null && <span className={styles.swatch} style={{ background: swatch(color) }} aria-hidden="true" />}
        <h2 className={styles.cardTitle}>{title}</h2>
      </header>
      <p className={styles.cardSub}>
        {varieties.join(', ')} · {year}, completed weeks
      </p>
      <dl className={styles.figures}>
        <div>
          <dt>Projected</dt>
          <dd>
            {acc.matched ? fmt(acc.projected) : '—'} <span>kg</span>
          </dd>
        </div>
        <div>
          <dt>Actual</dt>
          <dd>
            {acc.matched ? fmt(acc.actual) : '—'} <span>kg</span>
          </dd>
        </div>
        <div className={styles.errorFigure}>
          <dt>Forecast error</dt>
          <dd className={acc.errorPct === null ? undefined : acc.errorPct > 0 ? styles.over : styles.under}>
            {formatError(acc.errorPct)}
            {acc.errorPct !== null && <span> {errorWord(acc.errorPct)}</span>}
          </dd>
        </div>
      </dl>
      <p className={acc.matched && acc.matched === acc.expected ? styles.coverage : styles.coverageIncomplete}>
        {acc.matched === 0
          ? acc.expected === 0
            ? 'No completed week yet.'
            : `No completed week has both a forecast and an actual kg yet (${vw(acc.expected)}: ${excluded.join(', ')}).`
          : `Both totals cover the same ${acc.matched} of ${vw(acc.expected)}, in ${acc.weeks} week${acc.weeks === 1 ? '' : 's'}${excluded.length ? `; left out: ${excluded.join(', ')}` : ''}.`}
      </p>
    </article>
  )
}
