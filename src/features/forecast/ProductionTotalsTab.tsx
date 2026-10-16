import { useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'
import { EmptyState, ErrorState, LoadingState } from '../../components/States'
import { greenhouseIsoWeek } from '../collector/greenhouseWeek'
import { useCrops } from '../crops/api'
import { colorLabel, type Crop } from '../crops/model'
import { useOrganization } from '../organization/OrganizationProvider'
import { ProjectionsTabs } from '../projections/ProjectionsTabs'
import wpd from '../projections/WeeklyPlantDataTab.module.css'
import { useProductionSources } from './api'
import { productionTotals, type CellMissing, type TotalsCell, type TotalsCrop } from './productionTotals'
import fc from './HarvestForecastTab.module.css'
import styles from './ProductionTotalsTab.module.css'

const isoWeeksInYear = (year: number) => {
  const dec28 = new Date(Date.UTC(year, 11, 28))
  const thursday = new Date(dec28)
  thursday.setUTCDate(dec28.getUTCDate() + 3 - ((dec28.getUTCDay() + 6) % 7))
  return Math.ceil(((thursday.getTime() - Date.UTC(thursday.getUTCFullYear(), 0, 1)) / 86_400_000 + 1) / 7)
}

const fmt = (n: number | null) => (n === null ? '—' : Math.round(n).toLocaleString('en-US'))
const swatch = (color: string) => `var(--pepper-${['red', 'orange', 'yellow', 'green'].includes(color) ? color : 'other'})`
const colourName = (color: string) => colorLabel(color as Crop['color'])

const REASON = { no_forecast: 'no forecast', afw_needed: 'AFW needed', no_case_weight: 'no case weight' } as const

/** "Silverstone: AFW needed (W43, W44); Cadalora: no forecast (W45)". */
function missingSummary(missing: { m: CellMissing; yw: number }[]): string {
  const by = new Map<string, number[]>()
  for (const { m, yw } of missing) {
    const key = `${m.cropName}: ${REASON[m.reason]}`
    by.set(key, [...(by.get(key) ?? []), yw % 100])
  }
  return [...by.entries()].map(([k, weeks]) => `${k} (${[...new Set(weeks)].map((w) => `W${w}`).join(', ')})`).join('; ')
}

const STATUS_TEXT: Record<TotalsCell['status'], string> = {
  official: 'Official',
  locked: 'Locked (incl. late)',
  preliminary: 'Includes preliminary',
  none: 'No forecast',
}

/**
 * Projections › Production Totals: the greenhouse's projected harvest per week
 * by pepper colour and combined, added up from the Harvest Forecast figures.
 */
export function ProductionTotalsTab() {
  const organization = useOrganization()
  const crops = useCrops(organization.id)
  const [params, setParams] = useSearchParams()
  const today = greenhouseIsoWeek()

  const all = useMemo(() => crops.data ?? [], [crops.data])
  const years = useMemo(() => {
    const ys = new Set<number>([today.year])
    for (const c of all) for (let y = Number(c.planting_date.slice(0, 4)); y <= Number(c.pullout_date.slice(0, 4)); y++) ys.add(y)
    return [...ys].sort((a, b) => b - a)
  }, [all, today.year])
  const year = years.includes(Number(params.get('year'))) ? Number(params.get('year')) : today.year
  const maxWeek = isoWeeksInYear(year)
  // Default: next week, the week the Friday Breaker forecasts cover (earlier and later weeks via the presets).
  const nextWeek = year === today.year ? Math.min(today.week + 1, isoWeeksInYear(year)) : 1
  const defaultFrom = nextWeek
  const from = Math.min(Math.max(Number(params.get('from')) || defaultFrom, 1), maxWeek)
  const to = Math.min(Math.max(Number(params.get('to')) || (year === today.year ? nextWeek : maxWeek), from), maxWeek)
  const set = (changes: Record<string, string | null>) =>
    setParams(
      (prev) => {
        const p = new URLSearchParams(prev)
        for (const [k, v] of Object.entries(changes)) {
          if (v === null) p.delete(k)
          else p.set(k, v)
        }
        return p
      },
      { replace: true },
    )

  const totalsCrops: TotalsCrop[] = useMemo(
    () =>
      all.map((c) => ({
        id: c.id,
        name: c.name,
        color: c.color,
        caseWeightKg: c.case_weight_kg === null || c.case_weight_kg === undefined ? null : Number(c.case_weight_kg),
        plantingDate: c.planting_date,
        pulloutDate: c.pullout_date,
      })),
    [all],
  )
  const sources = useProductionSources(totalsCrops.map((c) => c.id), year)
  const weeks = useMemo(() => Array.from({ length: to - from + 1 }, (_, i) => year * 100 + from + i), [year, from, to])
  const totals = useMemo(() => (sources.data ? productionTotals(totalsCrops, sources.data, weeks) : null), [sources.data, totalsCrops, weeks])

  if (crops.isPending) return <LoadingState />
  if (crops.error) return <ErrorState error={crops.error} />
  if (all.length === 0) return <EmptyState title="No varieties yet" description="Add a variety in Settings." />

  const preset = (label: string, f: number, t: number) => (
    <button type="button" className={`button button-secondary ${styles.preset}`} onClick={() => set({ from: String(f), to: String(t) })}>
      {label}
    </button>
  )
  const weekOptions = Array.from({ length: maxWeek }, (_, i) => i + 1)
  const next = nextWeek

  return (
    <section className={wpd.section} aria-label="Production Totals">
      <div className={wpd.toolbar}>
        <ProjectionsTabs />
        <div className={wpd.selectors}>
          <label className={`field ${wpd.yearControl}`}>
            <span className="field-label">Year</span>
            <select className="input" value={year} onChange={(e) => set({ year: e.target.value, from: null, to: null })}>
              {years.map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </select>
          </label>
          <label className={`field ${wpd.yearControl}`}>
            <span className="field-label">From</span>
            <select className="input" value={from} onChange={(e) => set({ from: e.target.value, to: String(Math.max(to, Number(e.target.value))) })}>
              {weekOptions.map((w) => (
                <option key={w} value={w}>
                  W{w}
                </option>
              ))}
            </select>
          </label>
          <label className={`field ${wpd.yearControl}`}>
            <span className="field-label">To</span>
            <select className="input" value={to} onChange={(e) => set({ to: e.target.value, from: String(Math.min(from, Number(e.target.value))) })}>
              {weekOptions.map((w) => (
                <option key={w} value={w}>
                  W{w}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>
      <div className={styles.presets}>
        {year === today.year && preset(`Next week (W${next})`, next, next)}
        {year === today.year && preset('Next 5 weeks', next, Math.min(next + 4, maxWeek))}
        {year === today.year && preset('This week + 7', today.week, Math.min(today.week + 7, maxWeek))}
        {preset('Whole year', 1, maxWeek)}
      </div>

      <p className={fc.subtitle}>
        Added up from each variety’s Harvest Forecast: for every variety and week, its locked forecast (Official) if there is one, otherwise its saved
        Preliminary forecast, from the latest sampling week. Cases use each variety’s own case weight. Weeks a variety has no forecast, AFW or case weight for
        are marked incomplete, never counted as zero.
      </p>

      {sources.isPending ? (
        <LoadingState />
      ) : sources.error ? (
        <ErrorState error={sources.error} />
      ) : totals ? (
        <>
          <div className={styles.cards}>
            {totals.colours.map((g) => (
              <SummaryCard
                key={g.color}
                title={colourName(g.color)}
                color={g.color}
                varieties={g.crops.map((c) => c.name)}
                cell={totals.totals.byColour.get(g.color)!}
                missing={totals.weeks.flatMap((w) => w.byColour.get(g.color)!.missing.map((m) => ({ m, yw: w.yw })))}
                weeks={[from, to]}
              />
            ))}
            <SummaryCard
              title="All colours"
              color={null}
              varieties={[`${all.length} varieties`]}
              cell={totals.totals.all}
              missing={totals.weeks.flatMap((w) => w.all.missing.map((m) => ({ m, yw: w.yw })))}
              weeks={[from, to]}
            />
          </div>

          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th scope="col" rowSpan={2}>
                    Week
                  </th>
                  {totals.colours.map((g) => (
                    <th key={g.color} scope="colgroup" colSpan={2} className={styles.colourHead}>
                      <span className={styles.swatch} style={{ background: swatch(g.color) }} aria-hidden="true" />
                      {colourName(g.color)}
                    </th>
                  ))}
                  <th scope="colgroup" colSpan={2} className={`${styles.colourHead} ${styles.allHead}`}>
                    All colours
                  </th>
                </tr>
                <tr>
                  {[...totals.colours.map((g) => g.color), 'all'].flatMap((c) => [
                    <th key={`${c}kg`} scope="col" className={c === 'all' ? styles.allCol : undefined}>
                      kg
                    </th>,
                    <th key={`${c}cases`} scope="col" className={c === 'all' ? styles.allCol : undefined}>
                      Cases
                    </th>,
                  ])}
                </tr>
              </thead>
              <tbody>
                {totals.weeks.map((w) => (
                  <tr key={w.yw}>
                    <th scope="row">
                      W{w.yw % 100}
                      <StatusTag cell={w.all} />
                    </th>
                    {totals.colours.map((g) => (
                      <Cells key={g.color} cell={w.byColour.get(g.color)!} />
                    ))}
                    <Cells cell={w.all} all />
                  </tr>
                ))}
                <tr className={styles.totalRow}>
                  <th scope="row">
                    W{from}–W{to}
                    <StatusTag cell={totals.totals.all} />
                  </th>
                  {totals.colours.map((g) => (
                    <Cells key={g.color} cell={totals.totals.byColour.get(g.color)!} />
                  ))}
                  <Cells cell={totals.totals.all} all />
                </tr>
              </tbody>
            </table>
          </div>
          <p className={fc.fate}>
            <span className={styles.legend}>≥</span> partial: some varieties have no forecast, AFW or case weight that week (hover for which). <strong>P</strong>{' '}
            includes preliminary forecasts; <strong>O</strong> official locked forecasts only; <strong>L</strong> locked, including late ones. Preliminary totals are
            not official. Forecasts are experimental until validated against actual kg.
          </p>
        </>
      ) : null}
    </section>
  )
}

function StatusTag({ cell }: { cell: TotalsCell }) {
  if (cell.status === 'none') return null
  const letter = cell.status === 'official' ? 'O' : cell.status === 'locked' ? 'L' : 'P'
  return (
    <span
      className={`${styles.tag} ${styles[`tag_${cell.status}`]}`}
      title={`${STATUS_TEXT[cell.status]}${cell.anyOutdated ? ' · a preliminary forecast may be outdated (regenerate it on Harvest Forecast)' : ''}`}
    >
      {letter}
      {cell.anyOutdated ? '!' : ''}
    </span>
  )
}

function cellTitle(cell: TotalsCell): string {
  const lines = cell.sources.map(
    (s) => `${s.cropName}: ${fmt(s.kg)} kg · ${s.cases === null ? '— cases' : `${fmt(s.cases)} cases`} (${s.status === 'preliminary' ? 'Preliminary' : s.status === 'official' ? 'Official' : 'Late'}, from W${s.originYw % 100}${s.outdated ? ', may be outdated' : ''})`,
  )
  for (const m of cell.missing) lines.push(`${m.cropName}: ${REASON[m.reason]}`)
  if (cell.expected === 0) lines.push('No variety of this colour in season')
  return lines.join('\n')
}

function Cells({ cell, all }: { cell: TotalsCell; all?: boolean }) {
  const cls = all ? styles.allCol : undefined
  if (cell.expected === 0 && cell.sources.length === 0) {
    return (
      <>
        <td className={cls} title="No variety of this colour in season">
          ·
        </td>
        <td className={cls} />
      </>
    )
  }
  const partialKg = !cell.kgComplete
  const partialCases = !cell.casesComplete
  return (
    <>
      <td className={`${cls ?? ''} ${partialKg ? styles.partial : ''}`} title={cellTitle(cell)}>
        {cell.kg === null ? (partialKg ? <span className={styles.missing}>missing</span> : '—') : `${partialKg ? '≥ ' : ''}${fmt(cell.kg)}`}
      </td>
      <td className={`${cls ?? ''} ${partialCases ? styles.partial : ''}`} title={cellTitle(cell)}>
        {cell.cases === null ? (partialCases ? <span className={styles.missing}>missing</span> : '—') : `${partialCases ? '≥ ' : ''}${fmt(cell.cases)}`}
      </td>
    </>
  )
}

function SummaryCard({
  title,
  color,
  varieties,
  cell,
  missing,
  weeks,
}: {
  title: string
  color: string | null
  varieties: string[]
  cell: TotalsCell
  missing: { m: CellMissing; yw: number }[]
  weeks: [number, number]
}) {
  const complete = cell.kgComplete && cell.casesComplete
  return (
    <article className={`${styles.card} ${color === null ? styles.allCard : ''}`}>
      <header className={styles.cardHead}>
        {color !== null && <span className={styles.swatch} style={{ background: swatch(color) }} aria-hidden="true" />}
        <h2 className={styles.cardTitle}>{title}</h2>
        {cell.status !== 'none' && <span className={`${fc.badge} ${cell.status === 'preliminary' ? fc.badge_preview : fc.badge_official}`}>{STATUS_TEXT[cell.status]}</span>}
        {cell.anyOutdated && <span className={`${fc.badge} ${fc.badge_incomplete}`}>Possibly outdated</span>}
      </header>
      <p className={styles.cardSub}>
        {varieties.join(', ')} · W{weeks[0]}
        {weeks[1] !== weeks[0] ? `–W${weeks[1]}` : ''}
      </p>
      <dl className={styles.figures}>
        <div>
          <dt>Projected harvest</dt>
          <dd>
            {cell.kg === null ? '—' : `${cell.kgComplete ? '' : '≥ '}${fmt(cell.kg)}`} <span>kg</span>
          </dd>
        </div>
        <div>
          <dt>Projected cases</dt>
          <dd>
            {cell.cases === null ? '—' : `${cell.casesComplete ? '' : '≥ '}${fmt(cell.cases)}`} <span>cases</span>
          </dd>
        </div>
      </dl>
      {!complete && <p className={styles.incomplete}>Incomplete: {missingSummary(missing) || 'no forecast yet'}</p>}
    </article>
  )
}
