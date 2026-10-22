// Plants › Metrics: weekly fruit metrics per variety per m²: the counts on the
// sampled stems observed that week (weekly_variety_metrics(): one database
// call for the organization) ÷ those stems × the variety's stems/m² (picking
// stems ÷ area, from Settings). Read-only.

import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { EmptyState, ErrorState, LoadingState } from '../../components/States'
import { useGreenhouseWeek } from '../collector/greenhouseWeek'
import { cropColorVar } from '../collector/display'
import { useCrops } from '../crops/api'
import { sortCrops } from '../crops/model'
import { useOrganization } from '../organization/OrganizationProvider'
import { useWeeklyMetrics } from './api'
import { METRICS, cellDetail, coverageMark, formatPerM2, MIN_COVERAGE, perM2, stemsPerM2, weekLabel, weekRange, type WeekMetrics } from './metrics'
import twinStyles from './PlantsTwin.module.css'
import styles from './PlantsMetrics.module.css'

type Tip = { text: string; x: number; y: number }

export function PlantsMetrics() {
  const organization = useOrganization()
  const crops = useCrops(organization.id)
  const metrics = useWeeklyMetrics(organization.id)
  const scroller = useRef<HTMLDivElement>(null)
  const [tip, setTip] = useState<Tip | null>(null)
  // The greenhouse's current week (Toronto time) is still being sampled.
  const today = useGreenhouseWeek()
  const currentYw = today.year * 100 + today.week

  const varieties = useMemo(() => sortCrops(crops.data ?? []), [crops.data])
  const weeks = useMemo(() => weekRange(metrics.data ?? []), [metrics.data])
  const byCropWeek = useMemo(() => new Map((metrics.data ?? []).map((m) => [`${m.crop_id}:${m.yw}`, m])), [metrics.data])
  const multiYear = weeks.length > 0 && weeks[0].year !== weeks[weeks.length - 1].year

  // The most recent week in view: scroll to the right end once the table is there.
  const lastYw = weeks.length ? weeks[weeks.length - 1].yw : null
  useLayoutEffect(() => {
    const el = scroller.current
    if (el) el.scrollLeft = el.scrollWidth
  }, [lastYw, varieties.length])

  const updated = metrics.dataUpdatedAt ? new Date(metrics.dataUpdatedAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : null
  const show = (el: HTMLElement, text: string) => {
    const r = el.getBoundingClientRect()
    setTip({ text, x: Math.min(r.left, window.innerWidth - 310), y: r.bottom + 6 })
  }

  let body
  if (crops.isPending || metrics.isPending) body = <LoadingState />
  else if (crops.error || metrics.error) body = <ErrorState error={crops.error ?? metrics.error} />
  else if (varieties.length === 0) body = <EmptyState title="No varieties yet" description="Add a variety in Settings, then record plants with the mobile collector." />
  else if (weeks.length === 0) body = <EmptyState title="No observations yet" description="Weekly metrics appear once stems are recorded with the mobile collector." />
  else
    body = (
      <div className={styles.scroller} ref={scroller} onScroll={() => setTip(null)}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th className={styles.variety} scope="col">Variety</th>
              <th className={styles.metric} scope="col">Metric</th>
              {weeks.map((w) => (
                <th key={w.yw} scope="col">
                  {weekLabel(w, multiYear)}
                  {w.yw === currentYw && <span className={styles.inProgress}>In progress</span>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {varieties.flatMap((crop) =>
              METRICS.map((metric, i) => (
                <tr key={`${crop.id}:${metric.key}`} className={i === 0 ? styles.firstOfVariety : undefined}>
                  {i === 0 && (
                    <th className={styles.variety} rowSpan={METRICS.length} scope="rowgroup">
                      <span className={styles.swatch} style={{ background: cropColorVar(crop.color) }} aria-hidden="true" />
                      {crop.name}
                      <span className={styles.density}>
                        {stemsPerM2(crop) === null ? 'area or picking stems not set' : `${stemsPerM2(crop)!.toFixed(2)} stems/m²`}
                      </span>
                    </th>
                  )}
                  <th className={styles.metric} scope="row">
                    {metric.label}
                  </th>
                  {weeks.map((w) => {
                    const m: WeekMetrics | undefined = byCropWeek.get(`${crop.id}:${w.yw}`)
                    const density = stemsPerM2(crop)
                    const value = formatPerM2(perM2(m, metric.key, density))
                    const inProgress = w.yw === currentYw
                    const partial = value !== '—' && coverageMark(m, inProgress) === 'partial'
                    const detail = cellDetail(m, metric.key, crop.name, weekLabel(w, multiYear), density, inProgress)
                    return (
                      <td
                        key={w.yw}
                        className={`${styles.value} ${value === '—' ? styles.empty : ''} ${partial ? styles.partial : ''}`}
                        tabIndex={0}
                        aria-label={`${value}. ${detail}`}
                        onMouseEnter={(e) => show(e.currentTarget, detail)}
                        onMouseLeave={() => setTip(null)}
                        onFocus={(e) => show(e.currentTarget, detail)}
                        onBlur={() => setTip(null)}
                      >
                        {value}
                        {partial && <span aria-hidden="true">*</span>}
                      </td>
                    )
                  })}
                </tr>
              )),
            )}
          </tbody>
        </table>
      </div>
    )

  return (
    <section className={styles.section} aria-label="Plant metrics">
      <div className={styles.head}>
        <p className={styles.note}>
          Per m², per variety and week: fruit counted on the sampled stems observed that week (all rows, side shoots included) ÷ those stems × the variety’s
          stems/m² (picking stems ÷ area). A node counts in its latest recorded state; stems not observed are left out, never counted as zero; duplicate
          records count once. Hover a value for the counts.
        </p>
        <span className={twinStyles.updated}>
          {metrics.isFetching ? 'Updating…' : updated ? `Updated ${updated}` : ''}
          {' · '}
          <button type="button" className={twinStyles.linkButton} onClick={() => void metrics.refetch()} disabled={metrics.isFetching}>
            Refresh
          </button>
        </span>
      </div>
      {body}
      {weeks.length > 0 && varieties.length > 0 && (
        <p className={styles.legend}>
          <span className={styles.partial}>*</span> = partial sampling (less than {Math.round(MIN_COVERAGE * 100)}%)
        </p>
      )}
      {tip && (
        <div className={styles.tooltip} role="tooltip" style={{ left: tip.x, top: tip.y }}>
          {tip.text}
        </div>
      )}
    </section>
  )
}
