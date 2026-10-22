// Climate › Maturation: research view of Breaker → Harvested per variety with
// the climate over each fruit's period (maturation.ts). Read-only; it does not
// feed the forecast.

import { useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'
import { EmptyState, ErrorState, LoadingState } from '../../components/States'
import { useCrops } from '../crops/api'
import { sortCrops } from '../crops/model'
import { useOrganization } from '../organization/OrganizationProvider'
import { useClimateSource, useZoneUse } from './api'
import { ClimateTabs } from './ClimateTabs'
import { MIN_TEMP_COVERAGE, studyResult, summarize, type Exclusion, type Fruit, type Summary } from './maturation'
import { useMaturation, type MaturationData } from './maturationData'
import { bandSummaries, evaluate, MIN_TEST, MIN_TRAIN, type Measure } from './colourProgression'
import { pickVariety } from './varietyClimate'
import styles from './Climate.module.css'

const EXCLUSION_TEXT: Record<Exclusion, string> = {
  invalid_sequence: 'status went backwards or changed after harvest',
  harvest_before_breaker: 'Harvested recorded before Breaker',
  same_visit: 'Breaker and Harvested recorded at the same visit',
  flagged_unreliable: 'flagged as a possible recording error (not reviewed as legitimate)',
  reviewed_recording_error: 'reviewed as a recording error',
  node_deactivated: 'node removed in the collector',
  no_visit_before_breaker: 'first seen already at Breaker (start unknown)',
}

export function ClimateMaturation() {
  const organization = useOrganization()
  const source = useClimateSource(organization.id)
  const [params, setParams] = useSearchParams()
  const crops = useCrops(organization.id)
  const zoneUse = useZoneUse(organization.id)
  const varieties = useMemo(() => {
    const withZones = new Set((zoneUse.data ?? []).map((u) => u.crop_id))
    return sortCrops(crops.data ?? []).filter((c) => withZones.has(c.id))
  }, [crops.data, zoneUse.data])
  const memoryKey = `plants.climate.variety:${organization.id}`
  const remembered = (() => {
    try {
      return localStorage.getItem(memoryKey)
    } catch {
      return null
    }
  })()
  const cropId = pickVariety(varieties, params.get('crop'), remembered)
  const choose = (id: string) => {
    try {
      localStorage.setItem(memoryKey, id)
    } catch {
      // not remembered
    }
    setParams((p) => { const next = new URLSearchParams(p); next.set('crop', id); return next }, { replace: true })
  }
  const study = useMaturation(cropId, source.data?.time_zone ?? 'America/Toronto')

  const body = () => {
    if (source.isPending || crops.isPending || zoneUse.isPending || (study.isPending && cropId)) return <LoadingState />
    if (source.error || study.error) return <ErrorState error={(source.error ?? study.error)!} />
    if (!cropId || !study.data) return <EmptyState title="No variety has climate zones yet" description="Assign each variety its zones in Settings › Climate." />
    return (
      <>
        <Study fruits={study.data.fruits} climateFrom={study.data.climateFrom} climateTo={study.data.climateTo} />
        <ColourToHarvest progression={study.data.progression} />
      </>
    )
  }

  return (
    <section className={styles.section} aria-label="Maturation study">
      <div className={styles.toolbar}>
        <ClimateTabs />
      </div>
      <div className={styles.controls}>
        <select className={`input ${styles.compactSelect}`} value={cropId ?? ''} onChange={(e) => choose(e.target.value)} aria-label="Variety">
          {varieties.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <span className={`${styles.small} ${styles.muted}`}>Research · Breaker → Harvested · read-only, not used by forecasts</span>
      </div>
      {body()}
    </section>
  )
}

const f = (v: number | null, d = 0) => (v === null ? '—' : v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }))
const pct = (v: number | null) => (v === null ? '—' : `${Math.round(v * 100)}%`)

function Study({ fruits, climateFrom, climateTo }: { fruits: Fruit[]; climateFrom: string | null; climateTo: string | null }) {
  const all = studyResult(fruits, true)
  const noLegacy = studyResult(fruits, false)
  const legacyFruits = fruits.filter((x) => x.legacy).length
  const cell = (s: Summary, d = 0, range?: [Summary, Summary]) =>
    s.n === 0 ? (
      <td className={styles.muted}>—</td>
    ) : (
      <td>
        {f(s.median, d)} <span className={styles.muted}>median</span>
        <span className={styles.range}>
          mean {f(s.mean, d)} · {f(s.min, d)}–{f(s.max, d)} · n {s.n}
          {s.cv !== null ? ` · spread ${pct(s.cv)}` : ''}
          {range ? ` · plausible ${f(range[0].median, d)}–${f(range[1].median, d)}` : ''}
        </span>
      </td>
    )
  const row = (label: string, pick: (r: typeof all) => Summary, d = 0, range?: (r: typeof all) => [Summary, Summary]) => (
    <tr>
      <td className={styles.left}>{label}</td>
      {cell(pick(all), d, range?.(all))}
      {cell(pick(noLegacy), d, range?.(noLegacy))}
    </tr>
  )
  return (
    <>
      <div className={styles.card}>
        <h3 className={styles.chartTitle}>What the data allows</h3>
        <ul className={styles.small}>
          <li>
            {fruits.length} fruit recorded at Breaker and later Harvested ({legacyFruits} using legacy CropLink observations). Usable: {all.usable}. With enough temperature data: {all.withTemperature}; with complete radiation: {all.withRadiation}.
          </li>
          {Object.entries(all.excluded).map(([k, v]) => (
            <li key={k} className={styles.muted}>
              Excluded {v}: {EXCLUSION_TEXT[k as Exclusion]}.
            </li>
          ))}
          <li className={styles.muted}>
            Variety climate available {climateFrom ? `${climateFrom} – ${climateTo}` : 'for no day of this period'} (only days the variety had zones assigned). Fruit outside it are counted but have no climate.
          </li>
        </ul>
      </div>

      <div className={styles.card}>
        <h3 className={styles.chartTitle}>Breaker → Harvested</h3>
        <p className={`${styles.small} ${styles.muted}`}>
          Visits are weekly, so neither the start of Breaker nor the picking is seen exactly. Each fruit is a range: “plausible” gives the medians of the shortest
          (Breaker record → last visit before harvest) and longest (visit before Breaker → Harvested record) windows; the main figure is a central estimate
          (midpoints of both intervals), not a measurement. °C·days: sum of daily mean temperatures (no base temperature), only with ≥{' '}
          {Math.round(MIN_TEMP_COVERAGE * 100)}% of hourly readings and no empty day. Radiation: sum of daily 23:00 totals, only when every day has one. Spread = standard
          deviation ÷ mean (lower = more consistent).
        </p>
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th className={styles.left}>Central estimate</th>
                <th>All observations</th>
                <th>Excluding legacy CropLink</th>
              </tr>
            </thead>
            <tbody>
              {row('Days', (r) => r.days, 1, (r) => [r.shortestDays, r.longestDays])}
              {row('Mean temperature (°C·days)', (r) => r.degreeDays, 0, (r) => [r.degreeDaysShortest, r.degreeDaysLongest])}
              {row('Radiation (J/cm²)', (r) => r.radiation, 0)}
              {row('Average temperature (°C)', (r) => r.meanTemp, 1)}
              {row('Average RH (%)', (r) => r.meanRh, 0)}
              {row('Average CO₂ (ppm)', (r) => r.meanCo2, 0)}
            </tbody>
          </table>
        </div>
      </div>

      <details className={styles.card}>
        <summary className={styles.small}>Each fruit ({fruits.length})</summary>
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th className={styles.left}>Breaker / Harvested records</th>
                <th>Days (range)</th>
                <th>°C·days (range)</th>
                <th>Radiation</th>
                <th>Temp. coverage</th>
                <th className={styles.left}>Notes</th>
              </tr>
            </thead>
            <tbody>
              {fruits.slice(0, 500).map((x) => (
                <tr key={x.node}>
                  <td className={styles.left}>
                    {x.breakerRecord} → {x.harvestRecord}
                  </td>
                  <td>{x.central ? `${x.central.days} (${x.shortest!.days}–${x.longest!.days})` : '—'}</td>
                  <td>{x.central?.degreeDays != null ? `${f(x.central.degreeDays)} (${f(x.shortest!.degreeDays)}–${f(x.longest!.degreeDays)})` : '—'}</td>
                  <td>{x.central?.radiation != null && x.central.days > 0 ? f(x.central.radiation) : '—'}</td>
                  <td>{pct(x.central?.tempCoverage ?? null)}</td>
                  <td className={`${styles.left} ${styles.small} ${styles.muted}`}>
                    {[x.legacy ? 'legacy' : null, x.excluded ? `excluded: ${EXCLUSION_TEXT[x.excluded]}` : null, x.central && x.central.degreeDays === null ? 'not enough climate' : null]
                      .filter(Boolean)
                      .join(' · ')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </>
  )
}

const MEASURE_TEXT: Record<Measure, string> = { days: 'Days', degreeDays: '°C·days', radiation: 'Radiation (J/cm²)' }

/**
 * Post-harvest inspections: colour % at each Breaker photo against the time to
 * the fruit's harvest, for fruit whose harvest date is inferred from a complete
 * inspection or confirmed by a person. Exploratory: too few points give no
 * evaluation, and nothing here feeds a forecast.
 */
function ColourToHarvest({ progression }: { progression: MaturationData['progression'] }) {
  if (progression === null) {
    return (
      <div className={styles.card}>
        <h3 className={styles.chartTitle}>Colour → harvest (post-harvest inspections)</h3>
        <p className={`${styles.small} ${styles.muted}`}>Not available yet: harvests and inspections aren’t set up in this database.</p>
      </div>
    )
  }
  const { points, datedFruit, measuredFruit } = progression
  const bands = bandSummaries(points)
  const evaluations = evaluate(points)
  const near = points.filter((p) => p.lastBeforeHarvest)
  return (
    <div className={styles.card}>
      <h3 className={styles.chartTitle}>Colour → harvest (post-harvest inspections)</h3>
      <p className={`${styles.small} ${styles.muted}`}>
        Each point is a Breaker photo pair’s colour % (a person’s estimate wins over an automatic one) of a fruit whose harvest date is known: inferred from a
        complete post-harvest inspection, or confirmed by a person. Time to harvest runs from the photo day to the harvest day; °C·days and radiation follow the
        same coverage rules as above. Fruit without a dated harvest are left out; no date is guessed. The harvest’s minimum colour is the pickers’ target, not a
        measurement.
      </p>
      <ul className={styles.small}>
        <li>
          {datedFruit} harvested fruit with a dated harvest; {measuredFruit} of them have colour measurements ({points.length} measurements, {near.length} “near
          harvest”).
        </li>
        {near.length > 0 && (
          <li className={styles.muted}>
            Colour at the last photo before harvest: median {f(summarize(near.map((p) => p.percent)).median, 0)}% · median {f(summarize(near.map((p) => p.toHarvest.days)).median, 0)} days before
            harvest.
          </li>
        )}
      </ul>
      {points.length === 0 ? (
        <p className={`${styles.small} ${styles.muted}`}>
          No points yet. They appear once Breakers photographed at a post-harvest inspection are found harvested at a later complete inspection.
        </p>
      ) : (
        <>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th className={styles.left}>Colour at photo</th>
                  <th>Fruit · photos</th>
                  <th>Days to harvest</th>
                  <th>°C·days to harvest</th>
                  <th>J/cm² to harvest</th>
                </tr>
              </thead>
              <tbody>
                {bands.map((b) => (
                  <tr key={b.label}>
                    <td className={styles.left}>{b.label}</td>
                    <td>
                      {b.fruit} · {b.points}
                    </td>
                    {[b.days, b.degreeDays, b.radiation].map((x, i) => (
                      <td key={i}>
                        {x.n === 0 ? '—' : `${f(x.median, 0)} (${f(x.min, 0)}–${f(x.max, 0)})`}
                        {x.n > 0 && <span className={styles.range}>n {x.n}{x.cv !== null ? ` · spread ${pct(x.cv)}` : ''}</span>}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <h3 className={styles.chartTitle}>Which measure predicts the time left best?</h3>
          <p className={`${styles.small} ${styles.muted}`}>
            The prediction is the median of the photo’s colour band in the training points; the error is the mean absolute error ÷ the mean actual value, so the
            three measures can be compared (lower = better). Needs at least {MIN_TRAIN} training and {MIN_TEST} test points.
          </p>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th className={styles.left}>Held out</th>
                  <th>Train · test</th>
                  {(['days', 'degreeDays', 'radiation'] as const).map((m) => (
                    <th key={m}>{MEASURE_TEXT[m]}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {evaluations.length === 0 ? (
                  <tr>
                    <td className={`${styles.left} ${styles.muted}`} colSpan={5}>
                      Needs points on at least two harvest dates or two stems.
                    </td>
                  </tr>
                ) : (
                  evaluations.map((e) => (
                    <tr key={e.split}>
                      <td className={styles.left}>
                        {e.split === 'later_dates' ? 'Later harvest dates' : 'Other stems'}
                        <span className={styles.range}>{e.description}</span>
                      </td>
                      <td>
                        {e.train} · {e.test}
                      </td>
                      {(['days', 'degreeDays', 'radiation'] as const).map((m) => (
                        <td key={m}>{e.relativeError[m] === null ? <span className={styles.muted}>too few</span> : pct(e.relativeError[m])}</td>
                      ))}
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}

