// Climate › Reports: Yesterday and Last 7 Days for one variety. Figures come
// from the canonical variety values (crop_climate_hourly / crop_climate_daily,
// the projection climate inputs) and fixed rules in reports.ts; day and night
// from the climate computer's own sunrise/sunset rows.

import { useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { EmptyState, ErrorState, LoadingState } from '../../components/States'
import { localToUtcCandidates } from '../../../supabase/functions/_shared/climate/zonedTime.ts'
import { useCrops } from '../crops/api'
import { sortCrops } from '../crops/model'
import { useOrganization } from '../organization/OrganizationProvider'
import { useClimateSource, useCropClimateDaily, useCropClimateHourly, useDaylight, useZoneUse } from './api'
import { ClimateTabs } from './ClimateTabs'
import { localDate } from './model'
import { useNow } from './useNow'
import { pickVariety } from './varietyClimate'
import { DEFAULT_THRESHOLDS, addDays, computeReport, dayLabel, reportObservations, type Observation, type ReportStats, type Thresholds } from './reports'
import styles from './Climate.module.css'

const SECTIONS: { key: keyof ReturnType<typeof reportObservations>; title: string }[] = [
  { key: 'temperature', title: 'Temperature' },
  { key: 'rh', title: 'RH' },
  { key: 'co2', title: 'CO₂' },
  { key: 'irrigation', title: 'Irrigation' },
  { key: 'radiation', title: 'Radiation' },
]

export function ClimateReports() {
  const organization = useOrganization()
  const source = useClimateSource(organization.id)
  if (source.isPending) return <Frame><LoadingState /></Frame>
  if (source.error) return <Frame><ErrorState error={source.error} /></Frame>
  if (!source.data) return <Frame><EmptyState title="Climate data isn’t set up yet" description="An owner can set it up in Settings › Climate." /></Frame>
  return <Reports sourceId={source.data.id} timeZone={source.data.time_zone} />
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <section className={styles.section} aria-label="Climate reports">
      <div className={styles.toolbar}>
        <ClimateTabs />
      </div>
      {children}
    </section>
  )
}

/** UTC instant of local midnight starting a date. */
const midnight = (date: string, timeZone: string) => {
  const [y, m, d] = date.split('-').map(Number)
  return new Date(localToUtcCandidates({ year: y, month: m, day: d, hour: 0, minute: 0, second: 0 }, timeZone)[0]).toISOString()
}

function read<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key)
    return v === null ? fallback : { ...fallback, ...JSON.parse(v) }
  } catch {
    return fallback
  }
}
function write(key: string, value: unknown) {
  try {
    localStorage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value))
  } catch {
    // Storage blocked: the setting lasts for this visit only.
  }
}

function Reports({ sourceId, timeZone }: { sourceId: string; timeZone: string }) {
  const organization = useOrganization()
  const [params, setParams] = useSearchParams()
  const crops = useCrops(organization.id)
  const zoneUse = useZoneUse(organization.id)
  const varieties = useMemo(() => {
    const withZones = new Set((zoneUse.data ?? []).map((u) => u.crop_id))
    return sortCrops(crops.data ?? []).filter((c) => withZones.has(c.id))
  }, [crops.data, zoneUse.data])
  // The same remembered variety as Climate › Monitor.
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
    write(memoryKey, id)
    setParams((p) => { const next = new URLSearchParams(p); next.set('crop', id); return next }, { replace: true })
  }

  const thresholdKey = `plants.climate.reportThresholds:${organization.id}`
  const [thresholds, setThresholds] = useState<Thresholds>(() => read(thresholdKey, DEFAULT_THRESHOLDS))
  const saveThresholds = (t: Thresholds) => {
    setThresholds(t)
    write(thresholdKey, t)
  }

  // Completed greenhouse-local days: yesterday, and the seven days before today.
  const today = localDate(Math.floor(useNow() / 1000), timeZone)
  const yesterday = addDays(today, -1)
  const week = Array.from({ length: 7 }, (_, i) => addDays(today, i - 7))
  const fromIso = midnight(week[0], timeZone)
  const toIso = midnight(today, timeZone)

  const hourly = useCropClimateHourly(cropId, fromIso, toIso)
  const daily = useCropClimateDaily(cropId, week[0], yesterday)
  const daylight = useDaylight(sourceId, fromIso, toIso)

  if (crops.isPending || zoneUse.isPending) return <Frame><LoadingState /></Frame>
  if (varieties.length === 0)
    return (
      <Frame>
        <EmptyState title="No variety has climate zones yet" description="Assign each variety its zones in Settings › Climate." action={<Link to="/settings#climate">Settings › Climate</Link>} />
      </Frame>
    )
  const error = hourly.error ?? daily.error ?? daylight.error
  const ready = hourly.data && daily.data && daylight.data
  const yStats = ready ? computeReport([yesterday], hourly.data!, daily.data!, daylight.data!, thresholds, timeZone) : null
  const wStats = ready ? computeReport(week, hourly.data!, daily.data!, daylight.data!, thresholds, timeZone) : null

  return (
    <Frame>
      <div className={styles.controls}>
        <select className={`input ${styles.compactSelect}`} value={cropId ?? ''} onChange={(e) => choose(e.target.value)} aria-label="Variety">
          {varieties.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <ThresholdPanel value={thresholds} onChange={saveThresholds} />
      </div>
      <p className={`${styles.small} ${styles.muted}`}>
        Counts are hourly readings (on-the-hour values), not measured time above a threshold. Day and night follow the climate computer’s sunrise and sunset.
        Radiation and irrigation use each day’s 23:00 reading. The same values feed projection climate inputs.
      </p>
      {error ? (
        <ErrorState error={error} />
      ) : !ready ? (
        <LoadingState />
      ) : (
        <div className={styles.reportGrid}>
          <ReportCard title="Yesterday" subtitle={dayLabel(yesterday)} stats={yStats!} thresholds={thresholds} />
          <ReportCard title="Last 7 Days" subtitle={`${dayLabel(week[0])} – ${dayLabel(yesterday)}`} stats={wStats!} thresholds={thresholds} />
        </div>
      )}
    </Frame>
  )
}

function ReportCard({ title, subtitle, stats, thresholds }: { title: string; subtitle: string; stats: ReportStats; thresholds: Thresholds }) {
  const obs = reportObservations(stats, thresholds)
  const missing = stats.completeness.filter((c) => !c.complete)
  const reason = (c: ReportStats['completeness'][number]) =>
    [
      c.hoursRecorded < c.expectedHours ? `${c.expectedHours - c.hoursRecorded} of ${c.expectedHours} hourly files missing` : null,
      !c.radiationFinal || !c.irrigationFinal ? 'no final 23:00 total' : null,
    ]
      .filter(Boolean)
      .join(', ')
  // Days without any file are grouped into ranges ("no data Wed, Oct 14 – Sun, Oct 18").
  const notes: string[] = []
  let empty: string[] = []
  const flush = () => {
    if (empty.length) notes.push(`no data ${empty.length === 1 ? dayLabel(empty[0]) : `${dayLabel(empty[0])} – ${dayLabel(empty[empty.length - 1])}`}`)
    empty = []
  }
  for (const c of missing) {
    if (c.hoursRecorded === 0) {
      if (empty.length && addDays(empty[empty.length - 1], 1) !== c.date) flush()
      empty.push(c.date)
    } else {
      flush()
      notes.push(`${dayLabel(c.date)}: ${reason(c)}`)
    }
  }
  flush()
  return (
    <article className={styles.reportCard} aria-label={title}>
      <header className={styles.reportHead}>
        <h3 className={styles.chartTitle}>{title}</h3>
        <span className={`${styles.small} ${styles.muted}`}>{subtitle}</span>
      </header>
      <p className={`${styles.small} ${missing.length ? styles.partial : styles.muted}`}>
        {stats.dates.length === 1
          ? missing.length
            ? missing[0].hoursRecorded === 0 ? 'No data for this day.' : `Incomplete data: ${reason(missing[0])}.`
            : 'Complete data: 24 hourly files and both 23:00 totals.'
          : `${stats.completeDays} of ${stats.dates.length} days ${stats.completeDays === 1 ? 'has' : 'have'} complete data${notes.length ? ` · ${notes.join('; ')}` : ''}.`}
      </p>
      {SECTIONS.map((s) => (
        <section key={s.key} className={styles.reportSection}>
          <h4>{s.title}</h4>
          <ul>
            {obs[s.key].map((o: Observation, i) => (
              <li key={i} className={o.tone === 'notable' ? styles.notable : undefined}>
                {o.text}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </article>
  )
}

function ThresholdPanel({ value, onChange }: { value: Thresholds; onChange: (t: Thresholds) => void }) {
  const field = (key: keyof Thresholds, label: string, unit: string, optional = false) => (
    <label className={styles.thresholdField}>
      <span>{label}</span>
      <input
        className="input"
        type="number"
        inputMode="decimal"
        value={value[key] ?? ''}
        placeholder={optional ? 'not set' : undefined}
        onChange={(e) => {
          const v = e.target.value.trim()
          const num = v === '' ? null : Number(v)
          if (num !== null && !Number.isFinite(num)) return
          if (num === null && !optional) return
          onChange({ ...value, [key]: num })
        }}
      />
      <span className={styles.muted}>{unit}</span>
    </label>
  )
  return (
    <details className={styles.thresholds}>
      <summary className={styles.small}>Thresholds</summary>
      <div className={styles.thresholdGrid}>
        {field('highTemp', 'High temperature', '°C')}
        {field('lowTemp', 'Low temperature', '°C', true)}
        {field('highRh', 'High RH', '%')}
        {field('lowDayRh', 'Low daytime RH', '%')}
        {field('lowDayCo2', 'Low daytime CO₂', 'ppm', true)}
      </div>
      <p className={`${styles.small} ${styles.muted}`}>
        Saved on this device only. Low temperature and low CO₂ have no default: set them from your crop targets.{' '}
        <button type="button" className="button" onClick={() => onChange(DEFAULT_THRESHOLDS)}>
          Reset to defaults
        </button>
      </p>
    </details>
  )
}
