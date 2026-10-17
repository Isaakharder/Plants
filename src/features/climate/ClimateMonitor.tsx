// Climate › Monitor: hourly charts for chosen zones (or a planting's own
// zones), what's missing or unusable, and daily / weekly summaries.

import { useMemo } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { EmptyState, ErrorState, LoadingState } from '../../components/States'
import type { ClimateSeries } from '../../lib/database.types'
import { useCrops } from '../crops/api'
import { sortCrops } from '../crops/model'
import { useOrganization } from '../organization/OrganizationProvider'
import { useClimateSource, useClimateZones, useCropClimateZones, useCropSeries, useDaily, useImportStatus, useMissingHours, useSeries, useZoneUse } from './api'
import { ClimateChart } from './ClimateChart'
import { useNow } from './useNow'
import { todayIso } from '../../lib/dates'
import { ClimateTabs } from './ClimateTabs'
import {
  CHART_METRICS,
  combineZones,
  LINE_COLORS,
  dailyFromPoints,
  dailyRows,
  exclusionWarnings,
  localDate,
  missingWarning,
  pointsOf,
  radiationDailyTotals,
  radiationIncrements,
  radiationWarning,
  SOURCE_METRICS,
  sortZones,
  weekKey,
  weeklyRows,
  zoneName,
  type Assignment,
  type ChartMetric,
  type Line,
  type LinePoint,
  type QualityWarning,
  type SummaryRow,
} from './model'
import styles from './Climate.module.css'

const RANGES = { '24h': 1, '7d': 7, '30d': 30 } as const
type RangeKey = keyof typeof RANGES
const MAX_ZONES = 6
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

  const mode = params.get('view') === 'planting' ? 'planting' : 'zones'
  const range: RangeKey = (params.get('range') as RangeKey) in RANGES ? (params.get('range') as RangeKey) : '7d'
  const summary = params.get('summary') === 'weekly' ? 'weekly' : 'daily'
  const summaryMetric = (CHART_METRICS.find((m) => m.key === params.get('metric'))?.key ?? 'air_temperature') as ChartMetric
  const selected = (params.get('zones') ?? '').split(',').filter((id) => zoneById.has(id))
  const zoneIds = selected.length > 0 ? selected : zones.slice(0, 1).map((z) => z.id)
  const plantings = useMemo(() => {
    const withZones = new Set((zoneUse.data ?? []).map((u) => u.crop_id))
    return sortCrops(crops.data ?? []).filter((c) => withZones.has(c.id))
  }, [crops.data, zoneUse.data])
  const cropId = plantings.some((c) => c.id === params.get('crop')) ? params.get('crop')! : plantings[0]?.id

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

  // The window ends now, or at the latest data when imports have stopped (e.g. only a backfill so far).
  const latest = status.data?.latest_hour ? Date.parse(status.data.latest_hour) / 1000 : null
  const now = useNow()
  const nowH = Math.floor(now / 3_600_000) * HOUR
  const end = latest !== null && nowH - latest > 48 * HOUR ? latest + HOUR : nowH + HOUR
  const start = end - RANGES[range] * 24 * HOUR
  const fromIso = new Date(start * 1000).toISOString()
  const toIso = new Date(end * 1000).toISOString()

  const zoneSeries = useSeries(mode === 'zones' ? sourceId : undefined, zoneIds, SOURCE_METRICS, fromIso, toIso)
  const cropSeries = useCropSeries(mode === 'planting' ? cropId : undefined, SOURCE_METRICS, fromIso, toIso)
  const cropZones = useCropClimateZones(cropId)
  const missing = useMissingHours(sourceId, fromIso, toIso)

  const series = (mode === 'zones' ? zoneSeries.data : cropSeries.data) ?? []
  const seriesError = mode === 'zones' ? zoneSeries.error : cropSeries.error
  const seriesPending = mode === 'zones' ? zoneSeries.isPending && zoneIds.length > 0 : cropSeries.isPending && Boolean(cropId)
  const assignments: Assignment[] = useMemo(() => (cropZones.data ?? []).filter((a) => a.superseded_at === null), [cropZones.data])
  const gaps = (missing.data ?? []).map(([s, e]) => [Date.parse(s) / 1000, Date.parse(e) / 1000] as [number, number])

  const charts = CHART_METRICS.map((m) => {
    const order = (id: string) => (mode === 'zones' ? zoneIds.indexOf(id) : zones.findIndex((z) => z.id === id))
    const ofMetric = series.filter((s) => s.metric === m.source).sort((a, b) => order(a.zone_id) - order(b.zone_id))
    const statuses = { ok: 0, reset: 0, gap: 0, decrease: 0, after_decrease: 0, first: 0, missing: 0 }
    const zoneLines: (Line & { color: string })[] = ofMetric.map((s) => {
      let points: LinePoint[]
      if (m.key === 'radiation') {
        const r = radiationIncrements(s.points, timeZone)
        points = r.points
        for (const k of Object.keys(statuses) as (keyof typeof statuses)[]) statuses[k] += r.statuses[k]
      } else points = pointsOf(s)
      const idx = mode === 'zones' ? zoneIds.indexOf(s.zone_id) : ofMetric.indexOf(s)
      return { id: s.zone_id, label: label(s.zone_id), points, color: LINE_COLORS[(idx + 1) % LINE_COLORS.length] }
    })
    let lines = zoneLines
    let combinedNote: string | null = null
    if (mode === 'planting' && zoneLines.length > 0) {
      const combined = combineZones(new Map(zoneLines.map((l) => [l.id, l.points])), assignments, timeZone)
      const weighted = combined.some((p) => p.method === 'weighted')
      combinedNote = weighted ? null : 'Area shares not set: the planting line is a plain mean of its zones'
      lines = [{ id: 'planting', label: weighted ? 'Planting (area-weighted)' : 'Planting (unweighted)', points: combined, color: LINE_COLORS[0], emphasis: true }, ...zoneLines.map((l) => ({ ...l, color: `${l.color}99` }))]
    }
    return { m, lines, statuses, combinedNote }
  })

  const warnings: QualityWarning[] = [
    missingWarning(missing.data ?? [], timeZone),
    ...exclusionWarnings(series, label),
    radiationWarning(charts.find((c) => c.m.key === 'radiation')!.statuses),
  ].filter((w): w is QualityWarning => w !== null)
  if (mode === 'planting' && cropId && assignments.length === 0) warnings.push({ key: 'nozones', tone: 'warn', text: 'This planting has no climate zones assigned.' })

  return (
    <section className={styles.section} aria-label="Climate">
      <div className={styles.toolbar}>
        <ClimateTabs reviewCount={status.data?.to_review ?? 0} />
      </div>

      <div className={styles.controls}>
        <div className={styles.segmented} role="group" aria-label="View">
          <button type="button" aria-pressed={mode === 'zones'} onClick={() => set({ view: null })}>
            Zones
          </button>
          <button type="button" aria-pressed={mode === 'planting'} onClick={() => set({ view: 'planting' })} disabled={plantings.length === 0} title={plantings.length === 0 ? 'No planting has climate zones yet' : undefined}>
            Planting
          </button>
        </div>
        {mode === 'planting' && (
          <select className={`input ${styles.compactSelect}`} value={cropId ?? ''} onChange={(e) => set({ crop: e.target.value })} aria-label="Planting">
            {plantings.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        )}
        <div className={styles.segmented} role="group" aria-label="Range">
          {(Object.keys(RANGES) as RangeKey[]).map((r) => (
            <button key={r} type="button" aria-pressed={range === r} onClick={() => set({ range: r === '7d' ? null : r })}>
              {r}
            </button>
          ))}
        </div>
        <LatestNote status={status.data ?? null} end={end} nowH={nowH} />
      </div>

      {mode === 'zones' && (
        <div className={styles.chips} role="group" aria-label={`Zones (up to ${MAX_ZONES})`}>
          {zones.length === 0 && <span className={styles.muted}>No zones yet: they appear with the first imported file.</span>}
          {zones.map((z) => {
            const on = zoneIds.includes(z.id)
            const idx = zoneIds.indexOf(z.id)
            return (
              <button
                key={z.id}
                type="button"
                className={styles.chip}
                aria-pressed={on}
                disabled={!on && zoneIds.length >= MAX_ZONES}
                title={z.display_name ? z.source_label : undefined}
                onClick={() => {
                  const next = on ? zoneIds.filter((id) => id !== z.id) : [...zoneIds, z.id]
                  set({ zones: next.length ? next.join(',') : null })
                }}
              >
                {on && <span className={styles.swatch} style={{ background: LINE_COLORS[(idx + 1) % LINE_COLORS.length] }} />}
                {zoneName(z)}
              </button>
            )
          })}
        </div>
      )}
      {mode === 'planting' && cropId && <PlantingZones assignments={assignments} label={label} />}

      {warnings.length > 0 && (
        <ul className={styles.warnings} aria-label="Data quality">
          {warnings.map((w) => (
            <li key={w.key} className={`${styles.warning} ${w.tone === 'info' ? styles.info : ''}`}>
              ⚠ <span>{w.text}</span>
            </li>
          ))}
        </ul>
      )}

      {seriesError ? (
        <ErrorState error={seriesError} />
      ) : seriesPending ? (
        <LoadingState />
      ) : (
        charts.map(({ m, lines, combinedNote }) => (
          <div key={m.key} className={styles.chartCard}>
            <div className={styles.chartHead}>
              <h3 className={styles.chartTitle}>
                {m.label} <span className={styles.unit}>{m.unit}</span>
              </h3>
              <div className={styles.legend}>
                {combinedNote && <span>{combinedNote}</span>}
                {lines.length > 1 &&
                  lines.map((l) => (
                    <span key={l.id} className={styles.legendItem}>
                      <span className={styles.swatch} style={{ background: l.color }} />
                      {l.label}
                    </span>
                  ))}
              </div>
            </div>
            {lines.length === 0 ? (
              <p className={styles.empty}>
                {m.key === 'radiation' ? 'Not reported for these zones (the climate computer reports radiation under some zones only).' : 'No readings in this period.'}
              </p>
            ) : (
              <ClimateChart lines={lines} from={start} to={end} unit={m.unit} decimals={m.decimals} gaps={gaps} bars={m.key === 'radiation'} />
            )}
          </div>
        ))
      )}

      <Summaries
        sourceId={sourceId}
        timeZone={timeZone}
        mode={mode}
        zoneIds={zoneIds}
        cropId={cropId}
        assignments={assignments}
        label={label}
        end={end}
        summary={summary}
        metric={summaryMetric}
        onSummary={(s) => set({ summary: s === 'daily' ? null : s })}
        onMetric={(k) => set({ metric: k === 'air_temperature' ? null : k })}
      />
    </section>
  )
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

function PlantingZones({ assignments, label }: { assignments: Assignment[]; label: (id: string) => string }) {
  const today = todayIso()
  const current = assignments.filter((a) => a.valid_from <= today && (a.valid_until === null || a.valid_until > today))
  return (
    <div className={styles.chips} aria-label="This planting’s zones">
      {current.length === 0 ? (
        <span className={styles.muted}>No zones today.</span>
      ) : (
        current.map((a) => (
          <span key={a.zone_id} className={`${styles.chip} ${styles.chipStatic}`}>
            {label(a.zone_id)}
            {a.area_share !== null && <span className={styles.muted}>{Math.round(Number(a.area_share) * 1000) / 10}%</span>}
          </span>
        ))
      )}
      <span className={styles.small + ' ' + styles.muted}>Only these zones’ readings are used (assignments by date).</span>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Daily / weekly summaries
// ---------------------------------------------------------------------------

type Column = { id: string; label: string; color: string; rows: SummaryRow[]; radiation?: boolean }

function Summaries(props: {
  sourceId: string
  timeZone: string
  mode: 'zones' | 'planting'
  zoneIds: string[]
  cropId: string | undefined
  assignments: Assignment[]
  label: (id: string) => string
  end: number
  summary: 'daily' | 'weekly'
  metric: ChartMetric
  onSummary: (s: 'daily' | 'weekly') => void
  onMetric: (m: ChartMetric) => void
}) {
  const { sourceId, timeZone, mode, zoneIds, cropId, assignments, label, end, summary, metric } = props
  const days = summary === 'daily' ? 14 : 56
  const toDate = localDate(end - 1, timeZone)
  const fromDate = localDate(end - days * 86400, timeZone)
  const fromIso = new Date((end - days * 86400) * 1000).toISOString()
  const toIso = new Date(end * 1000).toISOString()
  const def = CHART_METRICS.find((m) => m.key === metric)!
  const isRadiation = metric === 'radiation'

  const daily = useDaily(sourceId, zoneIds, [def.source], fromDate, toDate, mode === 'zones' && !isRadiation)
  const radiation = useSeries(mode === 'zones' && isRadiation ? sourceId : undefined, zoneIds, ['radiation_sum'], fromIso, toIso)
  const crop = useCropSeries(mode === 'planting' ? cropId : undefined, [def.source], fromIso, toIso)

  const toRows = (d: Parameters<typeof dailyRows>[0]) => (summary === 'daily' ? dailyRows(d) : weeklyRows(d)).reverse()
  const columns: Column[] = []
  const pending = mode === 'zones' ? (isRadiation ? radiation.isPending : daily.isPending) : crop.isPending
  const error = mode === 'zones' ? (isRadiation ? radiation.error : daily.error) : crop.error

  const radiationColumn = (s: ClimateSeries): SummaryRow[] => {
    const totals = radiationDailyTotals(s.points, timeZone)
    if (summary === 'daily')
      return dailyRows(totals.map((t) => [t.localDate, t.hoursPresent, t.total, null, null, t.complete ? 0 : 1])).reverse()
    const byWeek = new Map<string, SummaryRow>()
    for (const t of totals) {
      const w = weekKey(t.localDate)
      const row = byWeek.get(w.key) ?? { key: w.key, label: `W${w.week} ${w.year}`, hours: 0, expectedHours: 7, mean: 0, min: null, max: null, excluded: 0 }
      if (t.complete && t.total !== null) {
        row.mean = (row.mean ?? 0) + t.total
        row.hours++
      } else row.excluded++
      byWeek.set(w.key, row)
    }
    return [...byWeek.values()].sort((a, b) => b.key.localeCompare(a.key))
  }

  if (mode === 'zones') {
    if (isRadiation) {
      for (const s of radiation.data ?? []) columns.push({ id: s.zone_id, label: label(s.zone_id), color: LINE_COLORS[(zoneIds.indexOf(s.zone_id) + 1) % LINE_COLORS.length], rows: radiationColumn(s), radiation: true })
    } else {
      for (const s of daily.data ?? []) columns.push({ id: s.zone_id, label: label(s.zone_id), color: LINE_COLORS[(zoneIds.indexOf(s.zone_id) + 1) % LINE_COLORS.length], rows: toRows(s.days) })
    }
  } else if (crop.data) {
    if (isRadiation) {
      crop.data.forEach((s, i) => columns.push({ id: s.zone_id, label: label(s.zone_id), color: LINE_COLORS[(i + 1) % LINE_COLORS.length], rows: radiationColumn(s), radiation: true }))
    } else {
      const byZone = new Map(crop.data.map((s) => [s.zone_id, pointsOf(s)]))
      const combined = combineZones(byZone, assignments, timeZone)
      columns.push({ id: 'planting', label: combined.some((p) => p.method === 'weighted') ? 'Planting (weighted)' : 'Planting (unweighted)', color: LINE_COLORS[0], rows: toRows(dailyFromPoints(combined, timeZone)) })
      crop.data.forEach((s, i) => columns.push({ id: s.zone_id, label: label(s.zone_id), color: LINE_COLORS[(i + 1) % LINE_COLORS.length], rows: toRows(dailyFromPoints(pointsOf(s), timeZone)) }))
    }
  }
  const keys = [...new Set(columns.flatMap((c) => c.rows.map((r) => r.key)))].sort().reverse()
  const rowLabel = new Map(columns.flatMap((c) => c.rows.map((r) => [r.key, r.label] as const)))

  return (
    <div className={styles.card}>
      <div className={styles.sectionHead}>
        <h3 className={styles.chartTitle}>{summary === 'daily' ? 'Daily summary · last 14 days' : 'Weekly summary · last 8 weeks'}</h3>
        <div className={styles.controls}>
          <div className={styles.segmented} role="group" aria-label="Summary">
            <button type="button" aria-pressed={summary === 'daily'} onClick={() => props.onSummary('daily')}>
              Daily
            </button>
            <button type="button" aria-pressed={summary === 'weekly'} onClick={() => props.onSummary('weekly')}>
              Weekly
            </button>
          </div>
          <select className={`input ${styles.compactSelect}`} value={metric} onChange={(e) => props.onMetric(e.target.value as ChartMetric)} aria-label="Metric">
            {CHART_METRICS.map((m) => (
              <option key={m.key} value={m.key}>
                {m.label}
              </option>
            ))}
          </select>
        </div>
      </div>
      <p className={`${styles.small} ${styles.muted}`}>
        {isRadiation
          ? `Radiation total per day (J/cm²): only days with a reading at 23:00 and no counter problem are complete.${summary === 'weekly' ? ' Weeks add up their complete days.' : ''}`
          : `Mean (min–max) of usable hourly values in ${def.unit}; flagged readings are left out. Hours with data are shown when fewer than expected.`}
      </p>
      {error ? (
        <ErrorState error={error} />
      ) : pending && (mode === 'zones' ? zoneIds.length > 0 : Boolean(cropId)) ? (
        <LoadingState />
      ) : columns.length === 0 ? (
        <p className={styles.empty}>{isRadiation ? 'Not reported for these zones.' : 'No readings in this period.'}</p>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>{summary === 'daily' ? 'Day' : 'Week'}</th>
                {columns.map((c) => (
                  <th key={c.id}>
                    <span className={styles.legendItem}>
                      <span className={styles.swatch} style={{ background: c.color }} />
                      {c.label}
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {keys.map((k) => (
                <tr key={k}>
                  <td>{rowLabel.get(k)}</td>
                  {columns.map((c) => (
                    <SummaryCell key={c.id} row={c.rows.find((r) => r.key === k)} decimals={def.decimals} radiation={Boolean(c.radiation)} weekly={summary === 'weekly'} />
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function SummaryCell({ row, decimals, radiation, weekly }: { row: SummaryRow | undefined; decimals: number; radiation: boolean; weekly: boolean }) {
  if (!row || row.mean === null) return <td className={styles.muted}>—</td>
  if (radiation) {
    const partial = row.excluded > 0
    return (
      <td className={partial ? styles.partial : undefined} title={partial ? (weekly ? `${row.excluded} incomplete day(s) left out` : 'Incomplete day: running total so far') : undefined}>
        {weekly ? row.mean.toFixed(0) : `${partial ? '≥ ' : ''}${row.mean.toFixed(1)}`}
        {weekly && <span className={styles.range}>{row.hours}/7 days</span>}
      </td>
    )
  }
  const short = row.hours < row.expectedHours
  return (
    <td>
      {row.mean.toFixed(decimals)}
      <span className={styles.range}>
        {row.min!.toFixed(decimals)}–{row.max!.toFixed(decimals)}
        {short && <span className={styles.partial}> · {row.hours}/{row.expectedHours} h</span>}
      </span>
    </td>
  )
}
