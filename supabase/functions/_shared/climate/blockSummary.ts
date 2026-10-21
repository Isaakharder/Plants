// Ridder Synopta "Block Summary" export → readings, exactly as written.
//
// The export is a small wide CSV: zones across the columns ("Zone 1".."Zone 22"
// in the "Block heating" header row), one metric per row ("Air temperature
// [°C]", "RH [%]", …) and system rows (System date/time, week number) in the
// first value column. Files are written in Windows-1252 ("°" is byte B0).
//
// Every non-blank cell of a metric row becomes a reading with its exact label,
// unit and text; nothing is rounded or converted. The file's hour comes from the
// filename (greenhouse wall-clock time), checked against the System date/time
// inside the file; a file whose hour can't be decided safely is quarantined
// (kept, with its reasons) rather than guessed.
//
// Pure TypeScript: used by the Edge Function (Deno) and the tests (Node).

import {
  formatLocal,
  fromWallMinutes,
  isoWeek,
  isValidDate,
  localToUtcCandidates,
  wallClock,
  wallMinutes,
  type LocalDateTime,
} from './zonedTime.ts'

export const PARSER_VERSION = 'synopta-block-summary/3'

/** A filename or System time this far from a whole hour is not trusted to name the hour. */
export const MAX_OFF_HOUR_MINUTES = 10
/**
 * The System date/time agrees with the filename when within this many minutes;
 * further apart, the file is quarantined (since parser /2: a renamed copy of
 * another hour must not be stored under the filename's hour).
 */
export const SYSTEM_TIME_TOLERANCE_MINUTES = 15

// Since parser /3 only six measurements are read (user decision, 2026-10-21):
// temperature, RH, CO₂ and cumulative irrigation per zone; radiation sum and
// cumulative drain % greenhouse-wide, from the first value column (B, which
// the header names "Zone 1"). Other rows (EC, pH, group activation time, …)
// stay in the stored original file but are not readings.
export type Metric = 'air_temperature' | 'relative_humidity' | 'co2' | 'radiation_sum' | 'irrigation_cumulative' | 'drain_percentage'

type MetricDef = { metric: Metric; unitRaw: string | null; unit: string | null; min?: number; max?: number; greenhouse?: boolean }

// Keyed by the row name without its [unit], lower case.
const METRICS: Record<string, MetricDef> = {
  'air temperature': { metric: 'air_temperature', unitRaw: '°C', unit: '°C', min: -20, max: 50 },
  rh: { metric: 'relative_humidity', unitRaw: '%', unit: '%', min: 0, max: 100 },
  'co2 concentration': { metric: 'co2', unitRaw: 'ppm', unit: 'ppm', min: 100, max: 5000 },
  // A running total since the morning restart (~08:00), greenhouse-wide.
  'radiation sum': { metric: 'radiation_sum', unitRaw: 'J/cm²', unit: 'J/cm²', min: 0, max: 5000, greenhouse: true },
  // Running totals since midnight, per zone.
  'cumulative irrigation (dripper)': { metric: 'irrigation_cumulative', unitRaw: 'ml/dripp', unit: 'ml/dripper', min: 0, max: 100_000 },
  // A running daily percentage, greenhouse-wide.
  'cumulative drain water percentage': { metric: 'drain_percentage', unitRaw: '%', unit: '%', min: 0, max: 100, greenhouse: true },
}

/** Rows the export always has that are deliberately not read. */
const NOT_READ = new Set(['average ec', 'average ph', 'group activation time'])

/** The greenhouse-wide column: the first value column (B), headed "Zone 1". */
export const GREENHOUSE_COLUMN = 1
export const GREENHOUSE_ZONE_LABEL = 'Zone 1'

// Rows describing the export itself; their value sits in the first value column.
const SYSTEM_ROWS: Record<string, 'weatherSystem' | 'systemTime' | 'systemDate' | 'weekNumber' | 'sunrise' | 'sunset'> = {
  'weather system': 'weatherSystem',
  'system time': 'systemTime',
  'system date': 'systemDate',
  'week number': 'weekNumber',
  'sunrise today': 'sunrise',
  'sunset today': 'sunset',
}

export type Problem = { code: string; message: string }

export type ParsedReading = {
  zone: string
  row_label: string
  metric: Metric
  unit: string | null
  unit_raw: string | null
  raw_text: string
  value: number | null
  flags: string[]
}

export type ParsedFile = {
  parserVersion: string
  encoding: 'utf-8' | 'windows-1252'
  status: 'parsed' | 'quarantined'
  problems: Problem[]
  warnings: Problem[]
  zones: { label: string; column: number }[]
  readings: ParsedReading[]
  meta: {
    headerLabel: string | null
    systemDateRaw: string | null
    systemTimeRaw: string | null
    weekNumberRaw: string | null
    sunriseRaw: string | null
    sunsetRaw: string | null
    weatherSystemRaw: string | null
    /** Rows not read: known ones (EC, pH, group activation time) and unrecognised ones. */
    notReadRows: string[]
    unknownRows: string[]
  }
  time: {
    filenameLocal: string | null
    systemLocal: string | null
    method: 'filename' | 'system' | 'review' | null
    hourLocal: string | null
    hourUtc: string | null
    dateOrder: 'MDY' | 'DMY' | 'either' | null
    /** The climate computer's System time minus the file's hour, in minutes. */
    clockOffsetMinutes: number | null
    candidatesUtc: string[]
  }
}

export type ParseOptions = {
  timeZone?: string
  /** When the file arrived (agent uploads): settles the repeated autumn hour. */
  receivedAt?: Date
  /**
   * Review of a quarantined file: the whole UTC hour a reviewer assigned. It
   * settles only timing problems; a file that can't be read stays quarantined.
   */
  hourOverrideUtc?: string
}

/** Problems about the file's hour only (a reviewer can settle these). */
export const TIME_PROBLEMS = new Set([
  'filename_time_off_hour',
  'ambiguous_system_date',
  'system_time_off_hour',
  'no_timestamp',
  'nonexistent_local_time',
  'repeated_hour_ambiguous',
  'system_time_mismatch',
])

// ---------------------------------------------------------------------------
// Text and CSV
// ---------------------------------------------------------------------------

export function decodeExport(bytes: Uint8Array): { text: string; encoding: 'utf-8' | 'windows-1252' } {
  let body = bytes
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) body = bytes.subarray(3)
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(body), encoding: 'utf-8' }
  } catch {
    return { text: new TextDecoder('windows-1252').decode(body), encoding: 'windows-1252' }
  }
}

/** RFC 4180-style rows: quoted fields, doubled quotes, CRLF or LF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else quoted = false
      } else field += ch
    } else if (ch === '"') quoted = true
    else if (ch === ',') {
      row.push(field)
      field = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else field += ch
  }
  if (field !== '' || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

/** "Air temperature [°C]" → { name: 'air temperature', unit: '°C' }. */
export function splitLabel(label: string): { name: string; unit: string | null } {
  const m = /^(.*?)\s*\[([^\]]*)\]\s*$/.exec(label)
  return m ? { name: m[1].trim().toLowerCase(), unit: m[2] } : { name: label.trim().toLowerCase(), unit: null }
}

const ZONE_LABEL = /^zone\s*\d+$/i
const NUMBER = /^[-+]?(\d+(\.\d*)?|\.\d+)$/

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

/** "Block Summary_20261017_100009.csv" → 2026-10-17 10:00:09 (wall clock). */
export function filenameLocalTime(filename: string): LocalDateTime | null {
  const m = /(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})(?!\d)/.exec(filename)
  if (!m) return null
  const [year, month, day, hour, minute, second] = m.slice(1).map(Number)
  if (!isValidDate(year, month, day) || hour > 23 || minute > 59 || second > 59) return null
  return { year, month, day, hour, minute, second }
}

/** "10/17/2026" → the readings it can be (month-first and/or day-first). */
export function systemDateCandidates(raw: string | null): { order: 'MDY' | 'DMY'; year: number; month: number; day: number }[] {
  const m = raw ? /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(raw.trim()) : null
  if (!m) return []
  const [a, b, year] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const out: { order: 'MDY' | 'DMY'; year: number; month: number; day: number }[] = []
  if (isValidDate(year, a, b)) out.push({ order: 'MDY', year, month: a, day: b })
  if (isValidDate(year, b, a) && a !== b) out.push({ order: 'DMY', year, month: b, day: a })
  return out
}

/** "Real time - 10:00" → { hour: 10, minute: 0 }; "Real time - --:--" → null. */
export function systemClock(raw: string | null): { hour: number; minute: number } | null {
  const m = raw ? /(\d{1,2}):(\d{2})\s*$/.exec(raw) : null
  if (!m) return null
  const hour = Number(m[1])
  const minute = Number(m[2])
  return hour <= 23 && minute <= 59 ? { hour, minute } : null
}

function nearestHour(t: LocalDateTime): { hour: LocalDateTime; offsetMinutes: number } {
  const minutes = wallMinutes(t)
  const hourMinutes = Math.round(minutes / 60) * 60
  return { hour: fromWallMinutes(hourMinutes), offsetMinutes: Math.round((minutes - hourMinutes) * 10) / 10 }
}

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

export function parseBlockSummary(bytes: Uint8Array, filename: string, options: ParseOptions = {}): ParsedFile {
  const timeZone = options.timeZone ?? 'America/Toronto'
  const { text, encoding } = decodeExport(bytes)
  const problems: Problem[] = []
  const warnings: Problem[] = []
  const quarantine = (code: string, message: string) => problems.push({ code, message })
  const warn = (code: string, message: string) => warnings.push({ code, message })

  const rows = parseCsv(text).map((r) => r.map((c) => c.trim()))
  const meta: ParsedFile['meta'] = {
    headerLabel: null,
    systemDateRaw: null,
    systemTimeRaw: null,
    weekNumberRaw: null,
    sunriseRaw: null,
    sunsetRaw: null,
    weatherSystemRaw: null,
    notReadRows: [],
    unknownRows: [],
  }
  const time: ParsedFile['time'] = {
    filenameLocal: null,
    systemLocal: null,
    method: null,
    hourLocal: null,
    hourUtc: null,
    dateOrder: null,
    clockOffsetMinutes: null,
    candidatesUtc: [],
  }

  // Header: the row with the most "Zone n" cells.
  let headerIdx = -1
  let best = 0
  rows.forEach((r, i) => {
    const n = r.filter((c) => ZONE_LABEL.test(c)).length
    if (n >= 2 && n > best) {
      best = n
      headerIdx = i
    }
  })
  const zones: { label: string; column: number }[] = []
  if (headerIdx < 0) quarantine('no_zone_header', 'No header row with zone columns ("Zone 1", "Zone 2", …) was found.')
  else {
    meta.headerLabel = rows[headerIdx][0] || null
    const seen = new Set<string>()
    rows[headerIdx].forEach((c, column) => {
      if (!ZONE_LABEL.test(c)) return
      if (seen.has(c)) quarantine('duplicate_zone_label', `The header names ${c} twice.`)
      seen.add(c)
      zones.push({ label: c, column })
    })
    if (rows[headerIdx][GREENHOUSE_COLUMN] !== GREENHOUSE_ZONE_LABEL) {
      quarantine(
        'unexpected_layout',
        `Column B is "${rows[headerIdx][GREENHOUSE_COLUMN] ?? ''}", not "${GREENHOUSE_ZONE_LABEL}": the greenhouse-wide radiation and drain can't be located safely.`,
      )
    }
  }

  // System rows (anywhere) and metric rows (after the header).
  const readings: ParsedReading[] = []
  const seenRows = new Set<string>()
  rows.forEach((r, i) => {
    const label = r[0] ?? ''
    if (!label || i === headerIdx) return
    const { name, unit: unitRaw } = splitLabel(label)
    const system = SYSTEM_ROWS[name]
    if (system) {
      const v = r[1] || null
      if (system === 'systemDate') meta.systemDateRaw = v
      else if (system === 'systemTime') meta.systemTimeRaw = v
      else if (system === 'weekNumber') meta.weekNumberRaw = v
      else if (system === 'sunrise') meta.sunriseRaw = v
      else if (system === 'sunset') meta.sunsetRaw = v
      else meta.weatherSystemRaw = v
      return
    }
    if (headerIdx < 0 || i < headerIdx) return
    if (seenRows.has(label)) {
      warn('duplicate_row', `The row "${label}" appears twice; only the first is kept.`)
      return
    }
    seenRows.add(label)
    const def = METRICS[name]
    if (!def) {
      meta.notReadRows.push(label)
      if (!NOT_READ.has(name)) {
        meta.unknownRows.push(label)
        warn('unrecognised_row', `Unrecognised row "${label}" (not read).`)
      }
      return
    }
    if ((def.unitRaw ?? null) !== (unitRaw ?? null)) {
      warn('unexpected_unit', `"${label}": expected unit ${def.unitRaw ?? 'none'}, found ${unitRaw ?? 'none'}.`)
    }
    const unitMatches = (def.unitRaw ?? null) === (unitRaw ?? null)
    for (const z of zones) {
      // Greenhouse-wide values come from column B only (Zone 15 repeats radiation and has a different drain figure).
      if (def.greenhouse && z.column !== GREENHOUSE_COLUMN) continue
      const raw = r[z.column] ?? ''
      if (raw === '') continue // blank: not reported for this zone
      const numeric = NUMBER.test(raw)
      const value = numeric ? Number(raw) : null
      const flags: string[] = []
      if (!unitMatches) flags.push('unexpected_unit')
      if (!numeric) flags.push('not_numeric')
      if (value !== null) {
        if (def.metric === 'irrigation_cumulative' && value === 0) flags.push('irrigation_zero')
        else if ((def.min !== undefined && value < def.min) || (def.max !== undefined && value > def.max)) flags.push('out_of_range')
      }
      readings.push({
        zone: z.label,
        row_label: label,
        metric: def.metric,
        unit: unitMatches ? def.unit : null,
        unit_raw: unitRaw,
        raw_text: raw,
        value,
        flags,
      })
    }
  })
  if (headerIdx >= 0 && readings.length === 0) quarantine('no_readings', 'The file has no readings.')

  // ---- The hour ----
  const fileLocal = filenameLocalTime(filename)
  const dates = systemDateCandidates(meta.systemDateRaw)
  const clock = systemClock(meta.systemTimeRaw)
  if (meta.systemDateRaw && dates.length === 0) warn('unreadable_system_date', `System date "${meta.systemDateRaw}" can't be read.`)
  const systemTimes = dates.map((d) => ({ order: d.order, t: { year: d.year, month: d.month, day: d.day, hour: clock?.hour ?? 0, minute: clock?.minute ?? 0, second: 0 } }))

  let hourLocal: LocalDateTime | null = null
  if (fileLocal) {
    time.filenameLocal = formatLocal(fileLocal)
    const { hour, offsetMinutes } = nearestHour(fileLocal)
    if (Math.abs(offsetMinutes) > MAX_OFF_HOUR_MINUTES) {
      quarantine('filename_time_off_hour', `The filename time ${time.filenameLocal} is ${offsetMinutes} minutes from a whole hour.`)
    } else {
      hourLocal = hour
      time.method = 'filename'
    }
    // Check the file's own System date/time against its name.
    const agreeing = systemTimes.filter((s) =>
      clock
        ? Math.abs(wallMinutes(s.t) - wallMinutes(fileLocal)) <= SYSTEM_TIME_TOLERANCE_MINUTES
        : s.t.year === fileLocal.year && s.t.month === fileLocal.month && s.t.day === fileLocal.day,
    )
    if (agreeing.length > 0) {
      // 'either': both readings agree (e.g. 10/10), so the file doesn't tell.
      const symmetric = dates.length === 1 && dates[0].month === dates[0].day
      time.dateOrder = agreeing.length === 2 || symmetric ? 'either' : agreeing[0].order
      if (clock) {
        time.systemLocal = formatLocal(agreeing[0].t)
        if (hourLocal) time.clockOffsetMinutes = wallMinutes(agreeing[0].t) - wallMinutes(hourLocal)
      }
    } else if (dates.length > 0) {
      quarantine(
        'system_time_mismatch',
        `The file's own System date/time (${meta.systemDateRaw} ${meta.systemTimeRaw ?? ''}) is more than ${SYSTEM_TIME_TOLERANCE_MINUTES} minutes from the time in its name (${time.filenameLocal}). It may be a renamed copy of another hour.`,
      )
    }
    if (!clock) warn('no_system_time', 'The file has no System time.')
  } else if (systemTimes.length > 0 && clock) {
    // No time in the filename: fall back to the System date/time, if unambiguous.
    const distinct = new Set(systemTimes.map((s) => formatLocal(s.t)))
    if (distinct.size > 1) {
      quarantine('ambiguous_system_date', `System date "${meta.systemDateRaw}" could be month-first or day-first and the filename has no date.`)
    } else {
      const s = systemTimes[0]
      time.systemLocal = formatLocal(s.t)
      time.dateOrder = dates.length === 1 && dates[0].month === dates[0].day ? 'either' : s.order
      const { hour, offsetMinutes } = nearestHour(s.t)
      if (Math.abs(offsetMinutes) > MAX_OFF_HOUR_MINUTES) {
        quarantine('system_time_off_hour', `System time ${time.systemLocal} is ${offsetMinutes} minutes from a whole hour.`)
      } else {
        hourLocal = hour
        time.method = 'system'
        time.clockOffsetMinutes = offsetMinutes
        warn('time_from_system_clock', 'The filename has no timestamp; the hour comes from the System date and time.')
      }
    }
  } else {
    quarantine('no_timestamp', 'Neither the filename nor the System date and time give the hour.')
  }

  if (hourLocal) {
    time.hourLocal = formatLocal(hourLocal)
    const week = meta.weekNumberRaw && /^\d{1,2}$/.test(meta.weekNumberRaw) ? Number(meta.weekNumberRaw) : null
    if (week !== null && week !== isoWeek(hourLocal.year, hourLocal.month, hourLocal.day)) {
      warn('week_number_mismatch', `Week number ${week} isn't the ISO week of ${time.hourLocal.slice(0, 10)}.`)
    }
    const candidates = localToUtcCandidates(hourLocal, timeZone)
    time.candidatesUtc = candidates.map((t) => new Date(t).toISOString())
    if (candidates.length === 0) {
      quarantine('nonexistent_local_time', `${time.hourLocal} doesn't exist in ${timeZone} (the clocks went forward).`)
    } else if (candidates.length === 1) {
      time.hourUtc = time.candidatesUtc[0]
    } else {
      // The repeated autumn hour: the agent uploads a file within moments of it
      // being written, so the occurrence it arrived just after is the one. A
      // late arrival (e.g. after an outage) or a manual upload goes to review.
      const received = options.receivedAt?.getTime()
      const ranked = received === undefined ? [] : candidates.filter((t) => received - t >= -5 * 60_000).sort((a, b) => Math.abs(received - a) - Math.abs(received - b))
      const resolved = ranked.length > 0 && Math.abs(received! - ranked[0]) <= 30 * 60_000 ? ranked[0] : null
      if (resolved !== null) {
        time.hourUtc = new Date(resolved).toISOString()
        warn('repeated_hour_resolved', `${time.hourLocal} happens twice (clocks went back); the time it arrived places it at ${time.hourUtc}.`)
      } else {
        quarantine('repeated_hour_ambiguous', `${time.hourLocal} happens twice (clocks went back) and can't be placed without review.`)
      }
    }
  }

  if (options.hourOverrideUtc !== undefined) {
    const t = Date.parse(options.hourOverrideUtc)
    if (!Number.isFinite(t) || t % 3_600_000 !== 0) throw new Error('The assigned hour must be a whole UTC hour.')
    for (let i = problems.length - 1; i >= 0; i--) if (TIME_PROBLEMS.has(problems[i].code)) problems.splice(i, 1)
    time.method = 'review'
    time.hourUtc = new Date(t).toISOString()
    time.hourLocal = formatLocal(wallClock(t, timeZone))
  }

  const status = problems.length === 0 ? 'parsed' : 'quarantined'
  if (status === 'quarantined') time.hourUtc = null
  return { parserVersion: PARSER_VERSION, encoding, status, problems, warnings, zones, readings, meta, time }
}
