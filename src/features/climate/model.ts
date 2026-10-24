// Climate page: pure helpers (no React, no network). Values come from the
// accepted files' original readings; nothing here invents a value: a missing,
// excluded or unsafe value stays missing and is reported.

import { wallClock } from '../../../supabase/functions/_shared/climate/zonedTime.ts'
import type { ClimateZoneRow, CropClimateZoneRow } from '../../lib/database.types'

export const GREENHOUSE_TIME_ZONE = 'America/Toronto'

/** Chart colours: the planting (or first zone) in the app's green, then distinct hues. */
export const LINE_COLORS = ['#2f6b3f', '#c4362c', '#1f6fb2', '#e07a1f', '#7a4bb5', '#0f8f86', '#b0428b', '#5d6a60']

/**
 * Whether a stored reading is one of the five measurements Plants uses (as
 * climate_is_measurement() in the database): radiation only from column B
 * ("Zone 1"). Older files also hold EC, pH, drain, group activation time and
 * Zone 15's radiation: kept as received, never used.
 */
export function isUsedMeasurement(metric: string, zoneLabel: string): boolean {
  if (metric === 'radiation_sum') return zoneLabel === 'Zone 1'
  return metric === 'air_temperature' || metric === 'relative_humidity' || metric === 'co2' || metric === 'irrigation_cumulative'
}


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
export function formatLocalHour(epochS: number, timeZone = GREENHOUSE_TIME_ZONE): string {
  const w = wallClock(epochS * 1000, timeZone)
  return `${w.year}-${pad(w.month)}-${pad(w.day)} ${pad(w.hour)}:00`
}

// ---------------------------------------------------------------------------
// Chart lines
// ---------------------------------------------------------------------------

export type LinePoint = { t: number; v: number | null; excluded: boolean }
export type Line = { id: string; label: string; points: LinePoint[]; emphasis?: boolean }

/**
 * The chart's value axis: the data's range with a little room. Values that differ only by
 * floating-point noise (e.g. a weighted mean of equal readings: 2.6 and 2.6000000000000005)
 * count as one value, so the axis never gets a near-zero span.
 */
export function valueRange(values: (number | null)[], bars = false): { yMin: number; yMax: number } {
  let lo = Infinity
  let hi = -Infinity
  for (const v of values) {
    if (v === null || !Number.isFinite(v)) continue
    if (v < lo) lo = v
    if (v > hi) hi = v
  }
  if (lo === Infinity) return { yMin: 0, yMax: 1 }
  if (bars) lo = Math.min(0, lo)
  if (hi - lo < 1e-9 * Math.max(1, Math.abs(hi))) {
    lo -= 1
    hi += 1
  }
  const pad = (hi - lo) * 0.08
  return { yMin: bars ? lo : lo - pad, yMax: hi + pad }
}

/** Round tick values for an axis; at most a dozen, whatever the range. */
export function niceTicks(min: number, max: number, count = 4): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max) || max < min) return []
  if (max - min < 1e-9 * Math.max(1, Math.abs(max))) return [min]
  const step0 = (max - min) / count
  const mag = 10 ** Math.floor(Math.log10(step0))
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= step0) ?? step0
  const out: number[] = []
  for (let i = Math.ceil(min / step); i * step <= max + step * 1e-9 && out.length < 12; i++) out.push(Math.round(i * step * 1e6) / 1e6)
  return out
}

export type Assignment = Pick<CropClimateZoneRow, 'zone_id' | 'valid_from' | 'valid_until' | 'area_share'>

/** The assignments in effect on a local date (current knowledge rows only). */
export function assignmentsOn(rows: Assignment[], date: string): Assignment[] {
  return rows.filter((a) => a.valid_from <= date && (a.valid_until === null || a.valid_until > date))
}

// ---------------------------------------------------------------------------
// Data-quality warnings
// ---------------------------------------------------------------------------

export type QualityWarning = { key: string; text: string; tone: 'warn' | 'info' }

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
// Upload health (Imports status cards)
// ---------------------------------------------------------------------------

/** How long after its hour a file arrived: "8 s", "4 min", "2 h 5 min", "3 days". Early arrivals (clock drift) count as 0. */
export function formatDelay(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s} s`
  const min = Math.round(s / 60)
  if (min < 60) return `${min} min`
  const h = Math.floor(min / 60)
  if (h < 48) return min % 60 ? `${h} h ${min % 60} min` : `${h} h`
  return `${Math.round(h / 24)} days`
}

/**
 * The upload was for an hour older than the newest stored hour: a backlog file
 * arriving late, not the current hour. An upload without an hour (quarantined)
 * is never a backlog.
 */
export function isBacklogUpload(uploadHourUtc: string | null, latestHourUtc: string | null): boolean {
  return Boolean(uploadHourUtc && latestHourUtc) && Date.parse(uploadHourUtc!) < Date.parse(latestHourUtc!)
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
