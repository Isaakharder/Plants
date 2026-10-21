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
import { useClimateSource, useCropClimateDaily, useCropClimateHourly, useDaylight, useReportThresholdHistory, useReportThresholds, useSaveReportThresholds, useZoneUse, type ReportThresholdsInEffect } from './api'
import { ClimateTabs } from './ClimateTabs'
import { localDate } from './model'
import { useNow } from './useNow'
import { pickVariety } from './varietyClimate'
import { addDays, computeReport, dayLabel, reportObservations, type Observation, type ReportStats, type Thresholds } from './reports'
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

  // The organization's shared thresholds (owners change them in the panel).
  const shared = useReportThresholds(organization.id)
  const thresholds = shared.data?.thresholds

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
  const error = hourly.error ?? daily.error ?? daylight.error ?? shared.error
  const ready = hourly.data && daily.data && daylight.data && thresholds
  const yStats = ready ? computeReport([yesterday], hourly.data!, daily.data!, daylight.data!, thresholds!, timeZone) : null
  const wStats = ready ? computeReport(week, hourly.data!, daily.data!, daylight.data!, thresholds!, timeZone) : null

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
        {shared.data && <ThresholdPanel inEffect={shared.data} organizationId={organization.id} owner={organization.role === 'owner'} />}
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
          <ReportCard title="Yesterday" subtitle={dayLabel(yesterday)} stats={yStats!} thresholds={thresholds!} />
          <ReportCard title="Last 7 Days" subtitle={`${dayLabel(week[0])} – ${dayLabel(yesterday)}`} stats={wStats!} thresholds={thresholds!} />
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

const WHEN = new Intl.DateTimeFormat('en-CA', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' })

/** The thresholds in effect for everyone; owners can change them (each change is kept). */
function ThresholdPanel({ inEffect, organizationId, owner }: { inEffect: ReportThresholdsInEffect; organizationId: string; owner: boolean }) {
  const t = inEffect.thresholds
  const [draft, setDraft] = useState<Record<keyof Thresholds, string> | null>(null)
  const [note, setNote] = useState('')
  const save = useSaveReportThresholds(organizationId)
  const history = useReportThresholdHistory(organizationId, owner && draft !== null)
  const fmt = (v: number | null, unit: string) => (v === null ? 'not set' : `${v} ${unit}`)
  const summary = [
    `High temperature ${fmt(t.highTemp, '°C')}`,
    `high RH ${fmt(t.highRh, '%')}`,
    `low daytime RH ${fmt(t.lowDayRh, '%')}`,
    `low temperature ${fmt(t.lowTemp, '°C')}`,
    `low daytime CO₂ ${fmt(t.lowDayCo2, 'ppm')}`,
  ].join(' · ')
  const start = () => {
    setDraft({ highTemp: String(t.highTemp), highRh: String(t.highRh), lowDayRh: String(t.lowDayRh), lowTemp: t.lowTemp === null ? '' : String(t.lowTemp), lowDayCo2: t.lowDayCo2 === null ? '' : String(t.lowDayCo2) })
    setNote('')
  }
  const parsed: Thresholds | null = draft && (() => {
    const req = (k: keyof Thresholds) => (draft[k].trim() === '' ? NaN : Number(draft[k]))
    const opt = (k: keyof Thresholds) => (draft[k].trim() === '' ? null : Number(draft[k]))
    const v = { highTemp: req('highTemp'), highRh: req('highRh'), lowDayRh: req('lowDayRh'), lowTemp: opt('lowTemp'), lowDayCo2: opt('lowDayCo2') }
    const ok = [v.highTemp, v.highRh, v.lowDayRh].every(Number.isFinite) && (v.lowTemp === null || Number.isFinite(v.lowTemp)) && (v.lowDayCo2 === null || Number.isInteger(v.lowDayCo2))
    return ok ? v : null
  })()
  const field = (key: keyof Thresholds, label: string, unit: string, optional = false) => (
    <label className={styles.thresholdField}>
      <span>{label}</span>
      <input className="input" type="number" inputMode="decimal" value={draft![key]} placeholder={optional ? 'not set' : undefined} onChange={(e) => setDraft({ ...draft!, [key]: e.target.value })} />
      <span className={styles.muted}>{unit}</span>
    </label>
  )
  return (
    <details className={styles.thresholds}>
      <summary className={styles.small}>Thresholds</summary>
      <p className={`${styles.small} ${styles.muted}`}>
        {summary}.{' '}
        {inEffect.source === 'default'
          ? 'Defaults (no owner has changed them).'
          : `Set ${WHEN.format(new Date(inEffect.recordedAt!))}${inEffect.note ? `: “${inEffect.note}”` : ''}.`}{' '}
        Shared by everyone in the organization. Night-time CO₂ isn’t assessed; unset thresholds aren’t counted.
      </p>
      {owner && draft === null && (
        <button type="button" className="button" onClick={start}>
          Change thresholds
        </button>
      )}
      {!owner && <p className={`${styles.small} ${styles.muted}`}>Only an owner can change them.</p>}
      {owner && draft !== null && (
        <div>
          <div className={styles.thresholdGrid}>
            {field('highTemp', 'High temperature', '°C')}
            {field('lowTemp', 'Low temperature', '°C', true)}
            {field('highRh', 'High RH', '%')}
            {field('lowDayRh', 'Low daytime RH', '%')}
            {field('lowDayCo2', 'Low daytime CO₂', 'ppm', true)}
          </div>
          <input className="input" value={note} maxLength={500} placeholder="Reason for the change (optional, kept in the history)" onChange={(e) => setNote(e.target.value)} />
          {save.error && <p className={`${styles.small} ${styles.partial}`}>Not saved: {save.error.message}</p>}
          <div className={styles.controls}>
            <button type="button" className="button button-primary" disabled={!parsed || save.isPending} onClick={() => parsed && save.mutate({ t: parsed, note }, { onSuccess: () => setDraft(null) })}>
              {save.isPending ? 'Saving…' : 'Save for everyone'}
            </button>
            <button type="button" className="button" onClick={() => setDraft(null)} disabled={save.isPending}>
              Cancel
            </button>
          </div>
          {(history.data ?? []).length > 0 && (
            <ul className={`${styles.small} ${styles.muted}`}>
              {history.data!.map((h) => (
                <li key={h.id}>
                  {WHEN.format(new Date(h.recorded_at))}: {h.high_temp} °C · RH {h.high_rh}/{h.low_day_rh}% · low {h.low_temp ?? '—'} °C · CO₂ {h.low_day_co2 ?? '—'} ppm{h.note ? ` — “${h.note}”` : ''}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </details>
  )
}
