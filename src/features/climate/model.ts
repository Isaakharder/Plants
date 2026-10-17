// Climate page: pure helpers (no React, no network). Values come from the
// accepted files' original readings; nothing here invents a value: a missing,
// excluded or unsafe value stays missing and is reported.

import { cumulativeIncrements, dailyTotals, type CumulativePoint, type IncrementStatus } from '../../../supabase/functions/_shared/climate/cumulative.ts'
import { isoWeek, wallClock } from '../../../supabase/functions/_shared/climate/zonedTime.ts'
import type { ClimateDailyDay, ClimatePoint, ClimateSeries, ClimateZoneRow, CropClimateZoneRow } from '../../lib/database.types'

export const GREENHOUSE_TIME_ZONE = 'America/Toronto'

/** Chart colours: the planting (or first zone) in the app's green, then distinct hues. */
export const LINE_COLORS = ['#2f6b3f', '#c4362c', '#1f6fb2', '#e07a1f', '#7a4bb5', '#0f8f86', '#b0428b', '#5d6a60']

export type ChartMetric = 'air_temperature' | 'relative_humidity' | 'co2' | 'ec' | 'radiation'

export const CHART_METRICS: { key: ChartMetric; label: string; unit: string; decimals: number; source: string }[] = [
  { key: 'air_temperature', label: 'Temperature', unit: '°C', decimals: 1, source: 'air_temperature' },
  { key: 'relative_humidity', label: 'Humidity', unit: '%', decimals: 0, source: 'relative_humidity' },
  { key: 'co2', label: 'CO₂', unit: 'ppm', decimals: 0, source: 'co2' },
  { key: 'ec', label: 'EC', unit: 'mS/cm', decimals: 1, source: 'ec' },
  // Radiation is exported as a running total since midnight; charts show each hour's increment.
  { key: 'radiation', label: 'Radiation', unit: 'J/cm² per hour', decimals: 1, source: 'radiation_sum' },
]

/** Metrics fetched for the page (database names). */
export const SOURCE_METRICS = [...CHART_METRICS.map((m) => m.source), 'ph']

export const zoneName = (z: Pick<ClimateZoneRow, 'display_name' | 'source_label'>) => z.display_name?.trim() || z.source_label

export function sortZones<T extends Pick<ClimateZoneRow, 'zone_number' | 'source_label'>>(zones: T[]): T[] {
  return [...zones].sort((a, b) => (a.zone_number ?? 1e9) - (b.zone_number ?? 1e9) || a.source_label.localeCompare(b.source_label))
}

// ---------------------------------------------------------------------------
// Local time
// ---------------------------------------------------------------------------

const pad = (n: number) => String(n).padStart(2, '0')

export function localDate(epochS: number, timeZone = GREENHOUSE_TIME_ZONE): string {
  const w = wallClock(epochS * 1000, timeZone)
  return `${w.year}-${pad(w.month)}-${pad(w.day)}`
}

export function localHour(epochS: number, timeZone = GREENHOUSE_TIME_ZONE): number {
  return wallClock(epochS * 1000, timeZone).hour
}

/** "W42 2026" for a local date (ISO week, as the greenhouse uses). */
export function weekKey(date: string): { key: string; year: number; week: number } {
  const [y, m, d] = date.split('-').map(Number)
  const week = isoWeek(y, m, d)
  // ISO week-year: early-January days can belong to the previous year's last week, and vice versa.
  const year = m === 1 && week >= 52 ? y - 1 : m === 12 && week === 1 ? y + 1 : y
  return { key: `${year}-W${pad(week)}`, year, week }
}

export function formatLocalHour(epochS: number, timeZone = GREENHOUSE_TIME_ZONE): string {
  const w = wallClock(epochS * 1000, timeZone)
  return `${w.year}-${pad(w.month)}-${pad(w.day)} ${pad(w.hour)}:00`
}

// ---------------------------------------------------------------------------
// Chart lines
// ---------------------------------------------------------------------------

export type LinePoint = { t: number; v: number | null; excluded: boolean }
export type Line = { id: string; label: string; points: LinePoint[]; emphasis?: boolean }

export function pointsOf(series: Pick<ClimateSeries, 'points'> | undefined): LinePoint[] {
  return (series?.points ?? []).map(([t, v, excluded]) => ({ t, v: excluded ? null : v, excluded: excluded === 1 }))
}

/** Hourly radiation increments from a running-total series; unsafe hours stay null. */
export function radiationIncrements(points: ClimatePoint[], timeZone = GREENHOUSE_TIME_ZONE): { points: LinePoint[]; statuses: Record<IncrementStatus, number> } {
  const cps: CumulativePoint[] = points.map(([t, v, excluded]) => ({
    hourUtc: new Date(t * 1000).toISOString(),
    localDate: localDate(t, timeZone),
    localHour: localHour(t, timeZone),
    value: excluded ? null : v,
  }))
  const inc = cumulativeIncrements(cps)
  const statuses: Record<IncrementStatus, number> = { ok: 0, reset: 0, gap: 0, decrease: 0, after_decrease: 0, first: 0, missing: 0 }
  for (const i of inc) statuses[i.status]++
  return { points: inc.map((i) => ({ t: Date.parse(i.hourUtc) / 1000, v: i.value, excluded: i.status === 'decrease' || i.status === 'after_decrease' })), statuses }
}

export function radiationDailyTotals(points: ClimatePoint[], timeZone = GREENHOUSE_TIME_ZONE) {
  return dailyTotals(
    points.map(([t, v, excluded]) => ({ hourUtc: new Date(t * 1000).toISOString(), localDate: localDate(t, timeZone), localHour: localHour(t, timeZone), value: excluded ? null : v })),
  )
}

// ---------------------------------------------------------------------------
// A planting's zones combined
// ---------------------------------------------------------------------------

/** Below this share of the planting's area with a usable value, the combined hour is left empty. */
export const MIN_AREA_COVERAGE = 0.75

export type Assignment = Pick<CropClimateZoneRow, 'zone_id' | 'valid_from' | 'valid_until' | 'area_share'>

/** The assignments in effect on a local date (current knowledge rows only). */
export function assignmentsOn(rows: Assignment[], date: string): Assignment[] {
  return rows.filter((a) => a.valid_from <= date && (a.valid_until === null || a.valid_until > date))
}

export type CombinedPoint = LinePoint & { method: 'weighted' | 'unweighted' | null; coverage: number | null }

/**
 * One value per hour for a planting. Area-weighted when every zone assigned
 * that day has an area share (renormalised over the zones with a usable value,
 * left empty below MIN_AREA_COVERAGE of the area); otherwise the plain mean of
 * the zones with a usable value, labelled unweighted.
 */
export function combineZones(byZone: Map<string, LinePoint[]>, assignments: Assignment[], timeZone = GREENHOUSE_TIME_ZONE): CombinedPoint[] {
  const hours = new Set<number>()
  for (const pts of byZone.values()) for (const p of pts) hours.add(p.t)
  const lookup = new Map<string, Map<number, LinePoint>>()
  for (const [zone, pts] of byZone) lookup.set(zone, new Map(pts.map((p) => [p.t, p])))
  return [...hours]
    .sort((a, b) => a - b)
    .map((t) => {
      const assigned = assignmentsOn(assignments, localDate(t, timeZone))
      const values = assigned.map((a) => ({ share: a.area_share, v: lookup.get(a.zone_id)?.get(t)?.v ?? null }))
      const usable = values.filter((x) => x.v !== null) as { share: number | null; v: number }[]
      if (assigned.length === 0 || usable.length === 0) return { t, v: null, excluded: false, method: null, coverage: null }
      const weighted = assigned.every((a) => a.area_share !== null)
      if (weighted) {
        const total = values.reduce((s, x) => s + Number(x.share), 0)
        const covered = usable.reduce((s, x) => s + Number(x.share), 0)
        const coverage = total > 0 ? covered / total : 0
        if (coverage < MIN_AREA_COVERAGE) return { t, v: null, excluded: false, method: 'weighted', coverage }
        return { t, v: usable.reduce((s, x) => s + x.v * Number(x.share), 0) / covered, excluded: false, method: 'weighted', coverage }
      }
      return { t, v: usable.reduce((s, x) => s + x.v, 0) / usable.length, excluded: false, method: 'unweighted', coverage: usable.length / assigned.length }
    })
}

// ---------------------------------------------------------------------------
// Daily and weekly summaries
// ---------------------------------------------------------------------------

export type SummaryRow = { key: string; label: string; hours: number; expectedHours: number; mean: number | null; min: number | null; max: number | null; excluded: number }

/** Daily rows from hourly points (planting view; the zone view gets them from the database). */
export function dailyFromPoints(points: LinePoint[], timeZone = GREENHOUSE_TIME_ZONE): ClimateDailyDay[] {
  const byDay = new Map<string, { n: number; sum: number; min: number; max: number; bad: number }>()
  for (const p of points) {
    const d = localDate(p.t, timeZone)
    const acc = byDay.get(d) ?? { n: 0, sum: 0, min: Infinity, max: -Infinity, bad: 0 }
    if (p.v === null) acc.bad += p.excluded ? 1 : 0
    else {
      acc.n++
      acc.sum += p.v
      acc.min = Math.min(acc.min, p.v)
      acc.max = Math.max(acc.max, p.v)
    }
    byDay.set(d, acc)
  }
  return [...byDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([d, a]) => [d, a.n, a.n ? a.sum / a.n : null, a.n ? a.min : null, a.n ? a.max : null, a.bad])
}

const DAY_LABEL = new Intl.DateTimeFormat('en-CA', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' })

export function dailyRows(days: ClimateDailyDay[]): SummaryRow[] {
  return days.map(([date, n, mean, min, max, excluded]) => ({
    key: date,
    label: DAY_LABEL.format(new Date(`${date}T12:00:00Z`)),
    hours: n,
    expectedHours: 24,
    mean,
    min,
    max,
    excluded,
  }))
}

/** Weekly rows: hour-weighted mean of the days, overall min/max. */
export function weeklyRows(days: ClimateDailyDay[]): SummaryRow[] {
  const byWeek = new Map<string, { label: string; n: number; sum: number; min: number; max: number; bad: number; days: number }>()
  for (const [date, n, mean, min, max, bad] of days) {
    const w = weekKey(date)
    const acc = byWeek.get(w.key) ?? { label: `W${w.week} ${w.year}`, n: 0, sum: 0, min: Infinity, max: -Infinity, bad: 0, days: 0 }
    acc.days++
    acc.bad += bad
    if (n > 0 && mean !== null) {
      acc.n += n
      acc.sum += mean * n
      acc.min = Math.min(acc.min, min ?? Infinity)
      acc.max = Math.max(acc.max, max ?? -Infinity)
    }
    byWeek.set(w.key, acc)
  }
  return [...byWeek.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, a]) => ({ key, label: a.label, hours: a.n, expectedHours: 7 * 24, mean: a.n ? a.sum / a.n : null, min: a.n ? a.min : null, max: a.n ? a.max : null, excluded: a.bad }))
}

// ---------------------------------------------------------------------------
// Data-quality warnings
// ---------------------------------------------------------------------------

const FLAG_TEXT: Record<string, string> = {
  ph_zero_sentinel: 'reported 0.0 pH (sensor not reporting)',
  ec_zero_suspect: 'reported 0.0 EC (suspicious)',
  out_of_range: 'reported values outside the physical range',
  not_numeric: 'reported values that aren’t numbers',
  unexpected_unit: 'reported an unexpected unit',
}

export type QualityWarning = { key: string; text: string; tone: 'warn' | 'info' }

/** Excluded readings by metric and reason, naming the zones. */
export function exclusionWarnings(series: ClimateSeries[], zoneLabel: (id: string) => string): QualityWarning[] {
  const groups = new Map<string, { metric: string; flag: string; zones: Set<string>; n: number }>()
  for (const s of series) {
    for (const [, , excluded, extra] of s.points) {
      if (!excluded || !Array.isArray(extra)) continue
      for (const flag of extra.filter((f) => f in FLAG_TEXT)) {
        const k = `${s.metric}:${flag}`
        const g = groups.get(k) ?? { metric: s.metric, flag, zones: new Set(), n: 0 }
        g.zones.add(zoneLabel(s.zone_id))
        g.n++
        groups.set(k, g)
      }
    }
  }
  return [...groups.entries()].map(([key, g]) => {
    const zones = [...g.zones]
    const who = zones.length > 3 ? `${zones.length} zones` : zones.join(', ')
    const metric = g.metric === 'ph' ? 'pH' : (CHART_METRICS.find((m) => m.source === g.metric)?.label ?? g.metric)
    return { key, tone: 'warn' as const, text: `${metric}: ${who} ${FLAG_TEXT[g.flag]} — ${g.n} reading${g.n === 1 ? '' : 's'} excluded.` }
  })
}

export function radiationWarning(statuses: Record<IncrementStatus, number>): QualityWarning | null {
  const fell = statuses.decrease + statuses.after_decrease
  const unsafe = statuses.gap + fell
  if (unsafe === 0) return null
  const parts = [statuses.gap ? `${statuses.gap} after a missing hour` : '', fell ? `${fell} around a fall in the running total` : ''].filter(Boolean)
  return { key: 'radiation', tone: 'warn', text: `Radiation: ${unsafe} hour${unsafe === 1 ? '' : 's'} can’t be converted to an hourly amount (${parts.join(', ')}).` }
}

/** "3 hours missing (17 Oct 11:00; 15 Sep 16:00 – 18 Sep 00:00 …)". */
export function missingWarning(gaps: [string, string, number][], timeZone = GREENHOUSE_TIME_ZONE): QualityWarning | null {
  const total = gaps.reduce((s, g) => s + Number(g[2]), 0)
  if (total === 0) return null
  const fmt = (iso: string) => formatLocalHour(Date.parse(iso) / 1000, timeZone).slice(5).replace('-', '/')
  const shown = [...gaps]
    .sort((a, b) => Number(b[2]) - Number(a[2]))
    .slice(0, 3)
    .map(([s, e, n]) => (Number(n) === 1 ? fmt(s) : `${fmt(s)} – ${fmt(new Date(Date.parse(e) - 3_600_000).toISOString())} (${n} h)`))
  return { key: 'missing', tone: 'warn', text: `${total} hour${total === 1 ? '' : 's'} without data: ${shown.join('; ')}${gaps.length > 3 ? ' …' : ''}.` }
}

// ---------------------------------------------------------------------------
// Area shares (planting form)
// ---------------------------------------------------------------------------

/** Area percentages: all blank, or all given and adding up to 100. Returns shares (0–1) or an error. */
export function parseAreaShares(percents: (string | undefined)[]): { shares: (number | null)[] } | { error: string } {
  const trimmed = percents.map((p) => (p ?? '').trim())
  if (trimmed.every((p) => p === '')) return { shares: trimmed.map(() => null) }
  if (trimmed.some((p) => p === '')) return { error: 'Give an area % for every zone, or leave them all blank.' }
  const values = trimmed.map((p) => Number(p.replace(',', '.')))
  if (values.some((v) => !Number.isFinite(v) || v <= 0 || v > 100)) return { error: 'Each area % must be more than 0 and at most 100.' }
  const sum = values.reduce((a, b) => a + b, 0)
  if (Math.abs(sum - 100) > 0.01) return { error: `Area % add up to ${Math.round(sum * 100) / 100}, not 100.` }
  return { shares: values.map((v) => Math.round(v * 100) / 10000) }
}
