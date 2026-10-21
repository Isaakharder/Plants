// Climate › Monitor: hourly charts for chosen zones (or a planting's own
// zones), what's missing or unusable, and daily / weekly summaries.

import { useMemo } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { EmptyState, ErrorState, LoadingState } from '../../components/States'
import { useCrops } from '../crops/api'
import { sortCrops } from '../crops/model'
import { useOrganization } from '../organization/OrganizationProvider'
import { useClimateSource, useClimateZones, useCropClimateZones, useCropSeries, useDaily, useDailyTotals, useImportStatus, useMissingHours, useSeries, useZoneUse } from './api'
import { TOTAL_METRICS, totalCell, weeklyTotals, type DailyTotalRow, type TotalMetric } from './dailyTotals'
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
  SOURCE_METRICS,
  sortZones,
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
  const metricParam = params.get('metric')
  const summaryMetric: SummaryMetric =
    (CHART_METRICS.find((m) => m.key === metricParam)?.key ?? TOTAL_METRICS.find((m) => m.key === metricParam)?.key ?? 'air_temperature') as SummaryMetric
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
  // Radiation and drain: column B ("Zone 1"), shared by every zone and planting. Irrigation: the zones shown.
  const greenhouseZoneId = zones.find((z) => z.source_label === 'Zone 1')?.id
  const irrigationZoneIds =
    mode === 'zones' ? zoneIds : [...new Set(assignments.filter((a) => a.valid_from <= todayIso() && (a.valid_until === null || a.valid_until > todayIso())).map((a) => a.zone_id))]
  const gaps = (missing.data ?? []).map(([s, e]) => [Date.parse(s) / 1000, Date.parse(e) / 1000] as [number, number])

  const charts = CHART_METRICS.map((m) => {
    const order = (id: string) => (mode === 'zones' ? zoneIds.indexOf(id) : zones.findIndex((z) => z.id === id))
    const ofMetric = series.filter((s) => s.metric === m.source).sort((a, b) => order(a.zone_id) - order(b.zone_id))
    const zoneLines: (Line & { color: string })[] = ofMetric.map((s) => {
      const points: LinePoint[] = pointsOf(s)
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
    return { m, lines, combinedNote }
  })

  const warnings: QualityWarning[] = [
    missingWarning(missing.data ?? [], timeZone),
    ...exclusionWarnings(series, label),
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
              <p className={styles.empty}>No readings in this period.</p>
            ) : (
              <ClimateChart lines={lines} from={start} to={end} unit={m.unit} decimals={m.decimals} gaps={gaps} />
            )}
          </div>
        ))
      )}

      <RunningTotals sourceId={sourceId} greenhouseZoneId={greenhouseZoneId} irrigationZoneIds={irrigationZoneIds} label={label} start={start} end={end} gaps={gaps} />

      <Summaries
        sourceId={sourceId}
        irrigationZoneIds={irrigationZoneIds}
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

type SummaryMetric = ChartMetric | TotalMetric
type Column = { id: string; label: string; color: string; rows: SummaryRow[] }

// ---------------------------------------------------------------------------
// Running totals: radiation and drain (greenhouse), irrigation (per zone)
// ---------------------------------------------------------------------------

/** The exported running totals hour by hour; a day's value is its final reading (see the summary below). */
function RunningTotals(props: {
  sourceId: string
  greenhouseZoneId: string | undefined
  irrigationZoneIds: string[]
  label: (id: string) => string
  start: number
  end: number
  gaps: [number, number][]
}) {
  const { sourceId, greenhouseZoneId, irrigationZoneIds, label, start, end, gaps } = props
  const fromIso = new Date(start * 1000).toISOString()
  const toIso = new Date(end * 1000).toISOString()
  const greenhouse = useSeries(sourceId, greenhouseZoneId ? [greenhouseZoneId] : [], ['radiation_sum', 'drain_percentage'], fromIso, toIso)
  const irrigation = useSeries(sourceId, irrigationZoneIds, ['irrigation_cumulative'], fromIso, toIso)
  const NOTES: Record<TotalMetric, string> = {
    radiation_sum: 'Whole greenhouse (cell B6). Restarts about 08:00 (until then it still shows the previous day’s total); the day’s value is the 23:00 reading.',
    irrigation_cumulative: 'Per zone (row 9), since midnight; the day’s value is the 23:00 reading.',
    drain_percentage: 'Whole greenhouse (cell B10), since midnight; the day’s value is the 22:00 reading.',
  }
  return (
    <>
      {TOTAL_METRICS.map((m) => {
        const q = m.greenhouse ? greenhouse : irrigation
        const series = (q.data ?? []).filter((s) => s.metric === m.key)
        const lines = series.map((s, i) => ({
          id: s.zone_id,
          label: m.greenhouse ? 'Greenhouse (all zones)' : label(s.zone_id),
          points: pointsOf(s),
          color: LINE_COLORS[(m.greenhouse ? 0 : irrigationZoneIds.indexOf(s.zone_id) + 1) % LINE_COLORS.length] ?? LINE_COLORS[i % LINE_COLORS.length],
        }))
        return (
          <div key={m.key} className={styles.chartCard}>
            <div className={styles.chartHead}>
              <h3 className={styles.chartTitle}>
                {m.label} <span className={styles.unit}>{m.unit}, running total</span>
              </h3>
              <div className={styles.legend}>
                {lines.length > 1 &&
                  lines.map((l) => (
                    <span key={l.id} className={styles.legendItem}>
                      <span className={styles.swatch} style={{ background: l.color }} />
                      {l.label}
                    </span>
                  ))}
              </div>
            </div>
            <p className={`${styles.small} ${styles.muted}`}>{NOTES[m.key]}</p>
            {q.error ? (
              <ErrorState error={q.error} />
            ) : q.isPending && (m.greenhouse ? Boolean(greenhouseZoneId) : irrigationZoneIds.length > 0) ? (
              <LoadingState />
            ) : lines.length === 0 ? (
              <p className={styles.empty}>No readings in this period.</p>
            ) : (
              <ClimateChart lines={lines} from={start} to={end} unit={m.unit} decimals={m.decimals} gaps={gaps} />
            )}
          </div>
        )
      })}
    </>
  )
}

// ---------------------------------------------------------------------------
// Daily / weekly summaries
// ---------------------------------------------------------------------------

function Summaries(props: {
  sourceId: string
  irrigationZoneIds: string[]
  timeZone: string
  mode: 'zones' | 'planting'
  zoneIds: string[]
  cropId: string | undefined
  assignments: Assignment[]
  label: (id: string) => string
  end: number
  summary: 'daily' | 'weekly'
  metric: SummaryMetric
  onSummary: (s: 'daily' | 'weekly') => void
  onMetric: (m: SummaryMetric) => void
}) {
  const { sourceId, irrigationZoneIds, timeZone, mode, zoneIds, cropId, assignments, label, end, summary, metric } = props
  const days = summary === 'daily' ? 14 : 56
  const toDate = localDate(end - 1, timeZone)
  const fromDate = localDate(end - days * 86400, timeZone)
  const fromIso = new Date((end - days * 86400) * 1000).toISOString()
  const toIso = new Date(end * 1000).toISOString()
  const hourlyDef = CHART_METRICS.find((m) => m.key === metric)
  const totalDef = TOTAL_METRICS.find((m) => m.key === metric)

  const daily = useDaily(sourceId, zoneIds, hourlyDef ? [hourlyDef.source] : [], fromDate, toDate, mode === 'zones' && Boolean(hourlyDef))
  const crop = useCropSeries(mode === 'planting' && hourlyDef ? cropId : undefined, hourlyDef ? [hourlyDef.source] : [], fromIso, toIso)
  const totals = useDailyTotals(sourceId, fromDate, toDate, irrigationZoneIds, Boolean(totalDef))

  const toRows = (d: Parameters<typeof dailyRows>[0]) => (summary === 'daily' ? dailyRows(d) : weeklyRows(d)).reverse()
  const columns: Column[] = []
  if (hourlyDef && mode === 'zones') {
    for (const s of daily.data ?? []) columns.push({ id: s.zone_id, label: label(s.zone_id), color: LINE_COLORS[(zoneIds.indexOf(s.zone_id) + 1) % LINE_COLORS.length], rows: toRows(s.days) })
  } else if (hourlyDef && crop.data) {
    const byZone = new Map(crop.data.map((s) => [s.zone_id, pointsOf(s)]))
    const combined = combineZones(byZone, assignments, timeZone)
    columns.push({ id: 'planting', label: combined.some((p) => p.method === 'weighted') ? 'Planting (weighted)' : 'Planting (unweighted)', color: LINE_COLORS[0], rows: toRows(dailyFromPoints(combined, timeZone)) })
    crop.data.forEach((s, i) => columns.push({ id: s.zone_id, label: label(s.zone_id), color: LINE_COLORS[(i + 1) % LINE_COLORS.length], rows: toRows(dailyFromPoints(pointsOf(s), timeZone)) }))
  }
  const keys = [...new Set(columns.flatMap((c) => c.rows.map((r) => r.key)))].sort().reverse()
  const rowLabel = new Map(columns.flatMap((c) => c.rows.map((r) => [r.key, r.label] as const)))
  const q = totalDef ? totals : mode === 'zones' ? daily : crop
  const pending = q.isPending && (totalDef ? true : mode === 'zones' ? zoneIds.length > 0 : Boolean(cropId))

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
          <select className={`input ${styles.compactSelect}`} value={metric} onChange={(e) => props.onMetric(e.target.value as SummaryMetric)} aria-label="Measurement">
            {[...CHART_METRICS, ...TOTAL_METRICS].map((m) => (
              <option key={m.key} value={m.key}>
                {m.label}
              </option>
            ))}
          </select>
        </div>
      </div>
      <p className={`${styles.small} ${styles.muted}`}>
        {totalDef
          ? `${totalDef.label} per day (${totalDef.unit}): the ${totalDef.key === 'drain_percentage' ? '22:00' : '23:00'} reading${totalDef.greenhouse ? ', the same for every zone and planting' : ', per zone'}. Running totals are never added up or averaged; a day without that reading shows its running value, marked “so far” (today) or “incomplete”.${summary === 'weekly' ? (totalDef.weekly === 'sum' ? ' Weeks add up their final days.' : ' Weeks average their final days.') : ''}`
          : `Mean (min–max) of usable hourly values in ${hourlyDef!.unit}; flagged readings are left out. Hours with data are shown when fewer than expected.`}
      </p>
      {q.error ? (
        <ErrorState error={q.error} />
      ) : pending ? (
        <LoadingState />
      ) : totalDef ? (
        <TotalsTable rows={(totals.data ?? []).filter((r) => r.metric === totalDef.key)} def={totalDef} weekly={summary === 'weekly'} label={label} irrigationZoneIds={irrigationZoneIds} />
      ) : columns.length === 0 ? (
        <p className={styles.empty}>No readings in this period.</p>
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
                    <SummaryCell key={c.id} row={c.rows.find((r) => r.key === k)} decimals={hourlyDef!.decimals} />
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

const DAY = new Intl.DateTimeFormat('en-CA', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' })

/** Daily values of a running total: final ones plain, partial ones marked; weekly: final days only. */
function TotalsTable(props: { rows: DailyTotalRow[]; def: (typeof TOTAL_METRICS)[number]; weekly: boolean; label: (id: string) => string; irrigationZoneIds: string[] }) {
  const { rows, def, weekly, label, irrigationZoneIds } = props
  const zoneIds = def.greenhouse ? [...new Set(rows.map((r) => r.zone_id))] : irrigationZoneIds.filter((id) => rows.some((r) => r.zone_id === id))
  if (zoneIds.length === 0) return <p className={styles.empty}>{def.greenhouse ? 'No readings in this period.' : 'Choose a zone to see its irrigation.'}</p>
  const colLabel = (id: string) => (def.greenhouse ? 'Greenhouse (all zones)' : label(id))
  const byZone = new Map(zoneIds.map((id) => [id, rows.filter((r) => r.zone_id === id)]))
  if (weekly) {
    const perZone = new Map(zoneIds.map((id) => [id, weeklyTotals(byZone.get(id)!, def.weekly)]))
    const weeks = perZone.get(zoneIds[0])!
    return (
      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Week</th>
              {zoneIds.map((id) => <th key={id}>{colLabel(id)}</th>)}
            </tr>
          </thead>
          <tbody>
            {weeks.map((w) => (
              <tr key={w.key}>
                <td>{w.label}</td>
                {zoneIds.map((id) => {
                  const x = perZone.get(id)!.find((y) => y.key === w.key)!
                  const partial = x.finalDays < x.days
                  return (
                    <td key={id} className={partial ? styles.partial : undefined} title={partial ? `${x.days - x.finalDays} day(s) without a final reading left out` : undefined}>
                      {x.value === null ? '—' : x.value.toFixed(def.weekly === 'sum' ? 0 : def.decimals)}
                      <span className={styles.range}>{x.finalDays}/{x.days} days final</span>
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )
  }
  const dates = [...new Set(rows.map((r) => r.local_date))].sort().reverse()
  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th>Day</th>
            {zoneIds.map((id) => <th key={id}>{colLabel(id)}</th>)}
          </tr>
        </thead>
        <tbody>
          {dates.map((d) => (
            <tr key={d}>
              <td>{DAY.format(new Date(`${d}T12:00:00Z`))}</td>
              {zoneIds.map((id) => {
                const r = byZone.get(id)!.find((x) => x.local_date === d)
                if (!r) return <td key={id} className={styles.muted}>—</td>
                const c = totalCell(r, def.decimals)
                return (
                  <td key={id} className={c.final ? undefined : styles.partial} title={c.title}>
                    {c.text}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function SummaryCell({ row, decimals }: { row: SummaryRow | undefined; decimals: number }) {
  if (!row || row.mean === null) return <td className={styles.muted}>—</td>
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
