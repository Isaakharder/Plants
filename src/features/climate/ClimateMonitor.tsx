// Climate › Monitor: one combined reading per variety for each of the five
// measurements (crop_climate_hourly / crop_climate_daily: the variety's zones
// combined in the database; radiation from the greenhouse-wide cell B6), the
// same values projection climate inputs use. Zone-level readings stay in the
// stored files (Imports › file details).

import { useMemo } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { EmptyState, ErrorState, LoadingState } from '../../components/States'
import { useCrops } from '../crops/api'
import { sortCrops } from '../crops/model'
import { useOrganization } from '../organization/OrganizationProvider'
import { useClimateSource, useClimateZones, useCropClimateDaily, useCropClimateHourly, useCropClimateZones, useImportStatus, useMissingHours, useZoneUse } from './api'
import { ClimateChart } from './ClimateChart'
import { useNow } from './useNow'
import { todayIso } from '../../lib/dates'
import { ClimateTabs } from './ClimateTabs'
import { LINE_COLORS, localDate, missingWarning, sortZones, zoneName, type Assignment, type QualityWarning } from './model'
import { VARIETY_METRICS, dayCell, pickVariety, weeklyClimate, type VarietyDay, type VarietyHour, type VarietyMetric } from './varietyClimate'
import styles from './Climate.module.css'

const RANGES = { '24h': 1, '7d': 7, '30d': 30 } as const
type RangeKey = keyof typeof RANGES
const HOUR = 3600

export function ClimateMonitor() {
  const organization = useOrganization()
  const source = useClimateSource(organization.id)
  if (source.isPending) return <Frame><LoadingState /></Frame>
  if (source.error) return <Frame><ErrorState error={source.error} /></Frame>
  if (!source.data)
    return (
      <Frame>
        <EmptyState
          title="Climate data isn’t set up yet"
          description={organization.role === 'owner' ? 'Set up the climate computer in Settings › Climate, then create an upload key for the agent.' : 'An owner can set it up in Settings › Climate.'}
          action={organization.role === 'owner' ? <Link to="/settings#climate">Go to Settings › Climate</Link> : undefined}
        />
      </Frame>
    )
  return <Monitor sourceId={source.data.id} timeZone={source.data.time_zone} />
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <section className={styles.section} aria-label="Climate">
      <div className={styles.toolbar}>
        <ClimateTabs />
      </div>
      {children}
    </section>
  )
}

function Monitor({ sourceId, timeZone }: { sourceId: string; timeZone: string }) {
  const organization = useOrganization()
  const [params, setParams] = useSearchParams()
  const zonesQ = useClimateZones(sourceId)
  const status = useImportStatus(sourceId)
  const crops = useCrops(organization.id)
  const zoneUse = useZoneUse(organization.id)

  const zones = useMemo(() => sortZones(zonesQ.data ?? []), [zonesQ.data])
  const zoneById = useMemo(() => new Map(zones.map((z) => [z.id, z])), [zones])
  const label = (id: string) => (zoneById.get(id) ? zoneName(zoneById.get(id)!) : '?')

  const range: RangeKey = (params.get('range') as RangeKey) in RANGES ? (params.get('range') as RangeKey) : '7d'
  const summary = params.get('summary') === 'weekly' ? 'weekly' : 'daily'
  const varieties = useMemo(() => {
    const withZones = new Set((zoneUse.data ?? []).map((u) => u.crop_id))
    return sortCrops(crops.data ?? []).filter((c) => withZones.has(c.id))
  }, [crops.data, zoneUse.data])
  // Remembered per organization on this device (a convenience: the link still wins).
  const memoryKey = `plants.climate.variety:${organization.id}`
  const cropId = pickVariety(varieties, params.get('crop'), readRemembered(memoryKey))
  const chooseVariety = (id: string) => {
    writeRemembered(memoryKey, id)
    set({ crop: id })
  }
  const set = (patch: Record<string, string | null>) =>
    setParams(
      (p) => {
        const next = new URLSearchParams(p)
        for (const [k, v] of Object.entries(patch)) {
          if (v === null) next.delete(k)
          else next.set(k, v)
        }
        return next
      },
      { replace: true },
    )

  // The window ends now, or at the latest data when imports have stopped.
  const latest = status.data?.latest_hour ? Date.parse(status.data.latest_hour) / 1000 : null
  const now = useNow()
  const nowH = Math.floor(now / 3_600_000) * HOUR
  const end = latest !== null && nowH - latest > 48 * HOUR ? latest + HOUR : nowH + HOUR
  const start = end - RANGES[range] * 24 * HOUR
  const fromIso = new Date(start * 1000).toISOString()
  const toIso = new Date(end * 1000).toISOString()

  const hourly = useCropClimateHourly(cropId, fromIso, toIso)
  const cropZones = useCropClimateZones(cropId)
  const missing = useMissingHours(sourceId, fromIso, toIso)
  const assignments: Assignment[] = useMemo(() => (cropZones.data ?? []).filter((a) => a.superseded_at === null), [cropZones.data])
  const gaps = (missing.data ?? []).map(([s, e]) => [Date.parse(s) / 1000, Date.parse(e) / 1000] as [number, number])
  const hours = hourly.data ?? []

  const warnings: QualityWarning[] = [missingWarning(missing.data ?? [], timeZone), coverageWarning(hours)].filter((w): w is QualityWarning => w !== null)
  if (cropId && assignments.length === 0) warnings.push({ key: 'nozones', tone: 'warn', text: 'This variety has no climate zones assigned.' })

  if (crops.isPending || zoneUse.isPending) return <Frame><LoadingState /></Frame>
  if (varieties.length === 0)
    return (
      <Frame>
        <EmptyState
          title="No variety has climate zones yet"
          description="Assign each variety its greenhouse zones in Settings › Climate; its climate is then combined from those zones."
          action={organization.role === 'owner' ? <Link to="/settings#climate">Go to Settings › Climate</Link> : undefined}
        />
      </Frame>
    )

  return (
    <section className={styles.section} aria-label="Climate">
      <div className={styles.toolbar}>
        <ClimateTabs reviewCount={status.data?.to_review ?? 0} />
      </div>

      <div className={styles.controls}>
        <select className={`input ${styles.compactSelect}`} value={cropId ?? ''} onChange={(e) => chooseVariety(e.target.value)} aria-label="Variety">
          {varieties.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <div className={styles.segmented} role="group" aria-label="Range">
          {(Object.keys(RANGES) as RangeKey[]).map((r) => (
            <button key={r} type="button" aria-pressed={range === r} onClick={() => set({ range: r === '7d' ? null : r })}>
              {r}
            </button>
          ))}
        </div>
        <LatestNote status={status.data ?? null} end={end} nowH={nowH} />
      </div>
      {cropId && <VarietyZones assignments={assignments} label={label} />}

      {warnings.length > 0 && (
        <ul className={styles.warnings} aria-label="Data quality">
          {warnings.map((w) => (
            <li key={w.key} className={`${styles.warning} ${w.tone === 'info' ? styles.info : ''}`}>
              ⚠ <span>{w.text}</span>
            </li>
          ))}
        </ul>
      )}

      {hourly.error ? (
        <ErrorState error={hourly.error} />
      ) : hourly.isPending ? (
        <LoadingState />
      ) : (
        VARIETY_METRICS.map((m) => {
          const points = hours.filter((h) => h.metric === m.key).map((h) => ({ t: Date.parse(h.hour_utc) / 1000, v: h.value, excluded: false }))
          return (
            <div key={m.key} className={styles.chartCard}>
              <div className={styles.chartHead}>
                <h3 className={styles.chartTitle}>
                  {m.label} <span className={styles.unit}>{m.unit}{m.kind === 'running' ? ', running total' : ''}</span>
                </h3>
              </div>
              <p className={`${styles.small} ${styles.muted}`}>{METRIC_NOTES[m.key]}</p>
              {points.every((p) => p.v === null) ? (
                <p className={styles.empty}>No readings in this period.</p>
              ) : (
                <ClimateChart lines={[{ id: m.key, label: m.label, points, color: LINE_COLORS[0] }]} from={start} to={end} unit={m.unit} decimals={m.decimals} gaps={gaps} />
              )}
            </div>
          )
        })
      )}

      <Summary cropId={cropId} timeZone={timeZone} end={end} summary={summary} onSummary={(s) => set({ summary: s === 'daily' ? null : s })} />
    </section>
  )
}

const METRIC_NOTES: Record<VarietyMetric, string> = {
  air_temperature: 'The variety’s zones combined, hour by hour.',
  relative_humidity: 'The variety’s zones combined, hour by hour.',
  co2: 'The variety’s zones combined, hour by hour.',
  radiation_sum: 'Whole greenhouse (cell B6), the same for every variety. Restarts about 08:00 (until then it still shows the previous day’s total); the day’s value is the 23:00 reading.',
  irrigation_cumulative: 'The variety’s zones combined (every zone must report), since midnight; the day’s value is the 23:00 reading.',
}

/** Hours left empty because too few of the variety's zones reported (never filled with 0). */
function coverageWarning(hours: VarietyHour[]): QualityWarning | null {
  const short = hours.filter((h) => h.value === null && h.zones_used > 0)
  if (short.length === 0) return null
  const by = new Map<string, number>()
  for (const h of short) by.set(h.metric, (by.get(h.metric) ?? 0) + 1)
  const parts = [...by.entries()].map(([m, n]) => `${VARIETY_METRICS.find((x) => x.key === m)?.label ?? m} ${n} h`)
  return { key: 'coverage', tone: 'warn', text: `Hours left empty because not enough of the variety’s zones reported: ${parts.join(', ')}.` }
}

function LatestNote({ status, end, nowH }: { status: { latest_hour: string | null } | null; end: number; nowH: number }) {
  if (!status?.latest_hour) return null
  const latest = Date.parse(status.latest_hour) / 1000
  const behind = Math.round((nowH - latest) / HOUR)
  return (
    <span className={`${styles.small} ${behind > 2 ? styles.stale : styles.muted}`}>
      Latest data {localDate(latest).slice(5).replace('-', '/')} {new Date(latest * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
      {behind > 2 && ` · ${behind} h behind`}
      {end < nowH && ' (window ends there)'}
    </span>
  )
}

function readRemembered(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function writeRemembered(key: string, id: string) {
  try {
    localStorage.setItem(key, id)
  } catch {
    // Private browsing or storage blocked: the choice just isn't remembered.
  }
}

/** One line: which zones the variety's readings combine, and how. */
function VarietyZones({ assignments, label }: { assignments: Assignment[]; label: (id: string) => string }) {
  const today = todayIso()
  const current = assignments.filter((a) => a.valid_from <= today && (a.valid_until === null || a.valid_until > today))
  const weighted = current.length > 0 && current.every((a) => a.area_share !== null)
  const names = current
    .map((a) => label(a.zone_id) + (a.area_share !== null ? ` (${Math.round(Number(a.area_share) * 1000) / 10}%)` : ''))
    .sort((x, y) => x.localeCompare(y, undefined, { numeric: true }))
  return (
    <p className={`${styles.small} ${styles.muted}`} aria-label="This variety’s zones">
      {current.length === 0
        ? 'No zones assigned today.'
        : `Combined from ${names.join(', ')} · ${weighted ? 'weighted by area share' : 'equal weights (no zone areas recorded; area shares can be added in Settings › Climate)'}.`}
    </p>
  )
}

// ---------------------------------------------------------------------------
// Daily / weekly summary: the five measurements side by side
// ---------------------------------------------------------------------------

const DAY = new Intl.DateTimeFormat('en-CA', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' })

function Summary(props: { cropId: string | undefined; timeZone: string; end: number; summary: 'daily' | 'weekly'; onSummary: (s: 'daily' | 'weekly') => void }) {
  const { cropId, timeZone, end, summary } = props
  const days = summary === 'daily' ? 14 : 56
  const toDate = localDate(end - 1, timeZone)
  const fromDate = localDate(end - days * 86400, timeZone)
  const daily = useCropClimateDaily(cropId, fromDate, toDate)
  const rows = useMemo(() => daily.data ?? [], [daily.data])
  const dates = [...new Set(rows.map((r) => r.local_date))].sort().reverse()
  const byKey = new Map(rows.map((r) => [`${r.local_date}|${r.metric}`, r]))
  const weeks = useMemo(() => new Map(VARIETY_METRICS.map((m) => [m.key, weeklyClimate(rows, m.key)])), [rows])
  // Weeks with at least one value (weeks before any climate data aren't listed).
  const weekKeys = [...new Set([...weeks.values()].flatMap((w) => w.filter((x) => x.value !== null).map((x) => x.key)))].sort().reverse()

  return (
    <div className={styles.card}>
      <div className={styles.sectionHead}>
        <h3 className={styles.chartTitle}>{summary === 'daily' ? 'Daily summary · last 14 days' : 'Weekly summary · last 8 weeks'}</h3>
        <div className={styles.segmented} role="group" aria-label="Summary">
          <button type="button" aria-pressed={summary === 'daily'} onClick={() => props.onSummary('daily')}>
            Daily
          </button>
          <button type="button" aria-pressed={summary === 'weekly'} onClick={() => props.onSummary('weekly')}>
            Weekly
          </button>
        </div>
      </div>
      <p className={`${styles.small} ${styles.muted}`}>
        {summary === 'daily'
          ? 'Temperature, RH and CO₂: mean of the day’s hours. Radiation and irrigation: the 23:00 reading (never a sum of the day’s readings); “so far” and “incomplete” mark days without it.'
          : 'Temperature, RH and CO₂: mean of the week’s hours. Radiation and irrigation: total of the week’s final days (n/7 shown).'}{' '}
        These are the values projection climate inputs use.
      </p>
      {daily.error ? (
        <ErrorState error={daily.error} />
      ) : daily.isPending && cropId ? (
        <LoadingState />
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>{summary === 'daily' ? 'Day' : 'Week'}</th>
                {VARIETY_METRICS.map((m) => (
                  <th key={m.key}>
                    {m.label} <span className={styles.unit}>{m.unit}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {summary === 'daily'
                ? dates.map((d) => (
                    <tr key={d}>
                      <td>{DAY.format(new Date(`${d}T12:00:00Z`))}</td>
                      {VARIETY_METRICS.map((m) => {
                        const c = dayCell(byKey.get(`${d}|${m.key}`) as VarietyDay | undefined, m.decimals)
                        return (
                          <td key={m.key} className={c.tone === 'partial' ? styles.partial : c.tone === 'none' ? styles.muted : undefined} title={c.title}>
                            {c.text}
                          </td>
                        )
                      })}
                    </tr>
                  ))
                : weekKeys.map((k) => (
                    <tr key={k}>
                      <td>{k.replace(/^(\d{4})-W0?(\d+)$/, 'W$2 $1')}</td>
                      {VARIETY_METRICS.map((m) => {
                        const w = weeks.get(m.key)!.find((x) => x.key === k)
                        if (!w || w.value === null) return <td key={m.key} className={styles.muted}>—</td>
                        return (
                          <td key={m.key} className={w.complete ? undefined : styles.partial}>
                            {w.value.toFixed(m.kind === 'running' ? 0 : m.decimals)}
                            <span className={styles.range}>{m.kind === 'running' ? `${w.finalDays}/7 days final` : `${w.hours}/${w.days * 24} h`}</span>
                          </td>
                        )
                      })}
                    </tr>
                  ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
