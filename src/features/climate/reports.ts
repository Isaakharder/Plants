// Climate › Reports: Yesterday and Last 7 Days for one variety, computed by
// rules from the canonical variety values (crop_climate_hourly /
// crop_climate_daily — the same values projection climate inputs use).
// Nothing here combines zones or invents conclusions.
//
// Day and night: the climate computer's own "Sunrise today" / "Sunset today"
// rows (stored with every file). An hourly reading is a snapshot on the hour;
// it counts as daytime when sunrise ≤ its time < sunset. Radiation's counter
// restart (~08:00) is NOT used for this. A date without sunrise/sunset leaves
// its readings unclassified (counted, but in neither day nor night).
//
// Counts are of hourly readings (snapshots). "3 hourly readings at or above
// 28 °C" means three on-the-hour values were; the exact time spent above the
// threshold is not measured.

import { localToUtcCandidates } from '../../../supabase/functions/_shared/climate/zonedTime.ts'
import type { VarietyDay, VarietyHour } from './varietyClimate'

export type Thresholds = {
  /** °C; readings at or above it count. */
  highTemp: number
  /** % RH; readings above it count. */
  highRh: number
  /** % RH; daytime readings below it count. */
  lowDayRh: number
  /** °C; readings below it count. Not set: not reported. */
  lowTemp: number | null
  /** ppm; daytime readings below it count. Not set: not reported. */
  lowDayCo2: number | null
}

export const DEFAULT_THRESHOLDS: Thresholds = { highTemp: 28, highRh: 88, lowDayRh: 70, lowTemp: null, lowDayCo2: null }

/** Sunrise and sunset (minutes after local midnight) per local date, from the files' System rows. */
export type Daylight = Map<string, { sunrise: number; sunset: number }>

/** "Real time - 07:48" → 468. */
export function parseClock(raw: unknown): number | null {
  const m = typeof raw === 'string' ? /(\d{1,2}):(\d{2})\s*$/.exec(raw) : null
  if (!m) return null
  const h = Number(m[1]), min = Number(m[2])
  return h <= 23 && min <= 59 ? h * 60 + min : null
}

/** Hours in a local calendar date (23 or 25 when the clocks change). */
export function hoursInDay(date: string, timeZone: string): number {
  const [y, m, d] = date.split('-').map(Number)
  const start = localToUtcCandidates({ year: y, month: m, day: d, hour: 0, minute: 0, second: 0 }, timeZone)[0]
  const next = new Date(Date.UTC(y, m - 1, d + 1))
  const end = localToUtcCandidates({ year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate(), hour: 0, minute: 0, second: 0 }, timeZone)[0]
  return Math.round((end - start) / 3_600_000)
}

export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10)
}

type Period = 'day' | 'night' | 'unknown'
type Obs = { date: string; hour: number; utc: string; value: number; period: Period }

export type Observation = { tone: 'notable' | 'info'; text: string }

export type DayCompleteness = {
  date: string
  expectedHours: number
  /** Hourly files in effect for the date. */
  hoursRecorded: number
  /** Radiation / irrigation 23:00 final present. */
  radiationFinal: boolean
  irrigationFinal: boolean
  complete: boolean
}

export type ReportStats = {
  dates: string[]
  completeness: DayCompleteness[]
  completeDays: number
  temperature: {
    dayMean: number | null; nightMean: number | null; max: { value: number; date: string; hour: number } | null; min: { value: number; date: string; hour: number } | null
    readings: number; highReadings: number; highDayReadings: number; daysReachingHigh: number; highRuns: { date: string; from: number; to: number; count: number }[]
    lowReadings: number | null; difference: number | null
  }
  rh: { dayMean: number | null; nightMean: number | null; highDay: number; highNight: number; lowDay: number; daysWithLowDay: number; days: number; longestHigh: { count: number; date: string; from: number } | null; nightsWithHigh: number; nights: number }
  co2: { dayMean: number | null; dayMin: number | null; dayMax: number | null; lowDay: number | null; dayReadings: number }
  radiation: { days: { date: string; value: number | null; status: VarietyDay['status'] }[]; finalDays: number; total: number | null; mean: number | null; highest: { date: string; value: number } | null; lowest: { date: string; value: number } | null }
  irrigation: { days: { date: string; value: number | null; status: VarietyDay['status'] }[]; finalDays: number; total: number | null; mean: number | null; per100J: number | null; per100JDays: number }
  unclassifiedReadings: number
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null)

export function computeReport(
  dates: string[],
  hours: readonly VarietyHour[],
  days: readonly VarietyDay[],
  daylight: Daylight,
  t: Thresholds,
  timeZone: string,
): ReportStats {
  const inRange = new Set(dates)
  const period = (date: string, hour: number): Period => {
    const dl = daylight.get(date)
    if (!dl) return 'unknown'
    const minutes = hour * 60
    return minutes >= dl.sunrise && minutes < dl.sunset ? 'day' : 'night'
  }
  const obs = (metric: VarietyHour['metric']): Obs[] =>
    hours
      .filter((h) => h.metric === metric && h.value !== null && inRange.has(h.local_date))
      .map((h) => ({ date: h.local_date, hour: h.local_hour, utc: h.hour_utc, value: h.value!, period: period(h.local_date, h.local_hour) }))
      .sort((a, b) => a.utc.localeCompare(b.utc))
  const day = (m: VarietyDay['metric'], date: string) => days.find((d) => d.metric === m && d.local_date === date)

  const completeness: DayCompleteness[] = dates.map((date) => {
    const recorded = new Set(hours.filter((h) => h.local_date === date).map((h) => h.hour_utc)).size
    const expected = hoursInDay(date, timeZone)
    const radiationFinal = day('radiation_sum', date)?.status === 'final'
    const irrigationFinal = day('irrigation_cumulative', date)?.status === 'final'
    return { date, expectedHours: expected, hoursRecorded: recorded, radiationFinal, irrigationFinal, complete: recorded >= expected && radiationFinal && irrigationFinal }
  })

  // Temperature
  const temp = obs('air_temperature')
  const highTemp = temp.filter((o) => o.value >= t.highTemp)
  const runs: { date: string; from: number; to: number; count: number }[] = []
  for (const o of highTemp) {
    const last = runs[runs.length - 1]
    const prev = last ? temp.find((x) => x.date === last.date && x.hour === last.to) : undefined
    if (last && prev && Date.parse(o.utc) - Date.parse(prev.utc) === 3_600_000) {
      last.to = o.hour
      last.count++
    } else runs.push({ date: o.date, from: o.hour, to: o.hour, count: 1 })
  }
  const maxT = temp.reduce<Obs | null>((a, o) => (!a || o.value > a.value ? o : a), null)
  const minT = temp.reduce<Obs | null>((a, o) => (!a || o.value < a.value ? o : a), null)
  const tDay = mean(temp.filter((o) => o.period === 'day').map((o) => o.value))
  const tNight = mean(temp.filter((o) => o.period === 'night').map((o) => o.value))

  // RH
  const rh = obs('relative_humidity')
  // Longest run of consecutive hourly readings above the threshold (a missing hour ends a run).
  type Run = { count: number; date: string; from: number; utc: string }
  const run: { cur: Run | null; longest: Run | null } = { cur: null, longest: null }
  for (const o of rh) {
    if (o.value > t.highRh) {
      const prev = run.cur
      run.cur = prev && Date.parse(o.utc) - Date.parse(prev.utc) === 3_600_000 ? { ...prev, count: prev.count + 1, utc: o.utc } : { count: 1, date: o.date, from: o.hour, utc: o.utc }
      if (!run.longest || run.cur.count > run.longest.count) run.longest = run.cur
    } else run.cur = null
  }
  const nightDates = new Set(rh.filter((o) => o.period === 'night').map((o) => o.date))
  const nightsWithHigh = new Set(rh.filter((o) => o.period === 'night' && o.value > t.highRh).map((o) => o.date)).size

  // CO₂ (daytime only: low CO₂ at night is expected)
  const co2Day = obs('co2').filter((o) => o.period === 'day')

  // Radiation and irrigation: the 23:00 finals only.
  const finals = (m: VarietyDay['metric']) => dates.map((date) => ({ date, value: day(m, date)?.status === 'final' ? day(m, date)!.value : null, status: day(m, date)?.status ?? ('no_data' as const) }))
  const rad = finals('radiation_sum')
  const irr = finals('irrigation_cumulative')
  const radFinal = rad.filter((r) => r.value !== null) as { date: string; value: number }[]
  const irrFinal = irr.filter((r) => r.value !== null) as { date: string; value: number }[]
  const both = dates.filter((d) => rad.find((r) => r.date === d)?.value != null && irr.find((r) => r.date === d)?.value != null)
  const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0)
  const radBoth = sum(both.map((d) => rad.find((r) => r.date === d)!.value!))
  const irrBoth = sum(both.map((d) => irr.find((r) => r.date === d)!.value!))

  return {
    dates,
    completeness,
    completeDays: completeness.filter((c) => c.complete).length,
    temperature: {
      dayMean: tDay, nightMean: tNight,
      max: maxT && { value: maxT.value, date: maxT.date, hour: maxT.hour },
      min: minT && { value: minT.value, date: minT.date, hour: minT.hour },
      readings: temp.length,
      highReadings: highTemp.length,
      highDayReadings: highTemp.filter((o) => o.period === 'day').length,
      daysReachingHigh: new Set(highTemp.map((o) => o.date)).size,
      highRuns: runs,
      lowReadings: t.lowTemp === null ? null : temp.filter((o) => o.value < t.lowTemp!).length,
      difference: tDay !== null && tNight !== null ? tDay - tNight : null,
    },
    rh: {
      dayMean: mean(rh.filter((o) => o.period === 'day').map((o) => o.value)),
      nightMean: mean(rh.filter((o) => o.period === 'night').map((o) => o.value)),
      highDay: rh.filter((o) => o.period === 'day' && o.value > t.highRh).length,
      highNight: rh.filter((o) => o.period === 'night' && o.value > t.highRh).length,
      lowDay: rh.filter((o) => o.period === 'day' && o.value < t.lowDayRh).length,
      daysWithLowDay: new Set(rh.filter((o) => o.period === 'day' && o.value < t.lowDayRh).map((o) => o.date)).size,
      days: new Set(rh.map((o) => o.date)).size,
      longestHigh: run.longest && { count: run.longest.count, date: run.longest.date, from: run.longest.from },
      nightsWithHigh,
      nights: nightDates.size,
    },
    co2: {
      dayMean: mean(co2Day.map((o) => o.value)),
      dayMin: co2Day.length ? Math.min(...co2Day.map((o) => o.value)) : null,
      dayMax: co2Day.length ? Math.max(...co2Day.map((o) => o.value)) : null,
      lowDay: t.lowDayCo2 === null ? null : co2Day.filter((o) => o.value < t.lowDayCo2!).length,
      dayReadings: co2Day.length,
    },
    radiation: {
      days: rad, finalDays: radFinal.length,
      total: radFinal.length ? sum(radFinal.map((r) => r.value)) : null,
      mean: radFinal.length ? sum(radFinal.map((r) => r.value)) / radFinal.length : null,
      highest: radFinal.length ? radFinal.reduce((a, r) => (r.value > a.value ? r : a)) : null,
      lowest: radFinal.length ? radFinal.reduce((a, r) => (r.value < a.value ? r : a)) : null,
    },
    irrigation: {
      days: irr, finalDays: irrFinal.length,
      total: irrFinal.length ? sum(irrFinal.map((r) => r.value)) : null,
      mean: irrFinal.length ? sum(irrFinal.map((r) => r.value)) / irrFinal.length : null,
      per100J: both.length && radBoth > 0 ? (irrBoth / radBoth) * 100 : null,
      per100JDays: both.length,
    },
    unclassifiedReadings: [...temp, ...rh].filter((o) => o.period === 'unknown').length,
  }
}

// ---------------------------------------------------------------------------
// Wording
// ---------------------------------------------------------------------------

const f1 = (v: number) => v.toFixed(1)
const f0 = (v: number) => Math.round(v).toLocaleString('en-US')
const hh = (h: number) => `${String(h).padStart(2, '0')}:00`
const n = (count: number, one: string, many = `${one}s`) => `${count === 0 ? 'no' : count === 1 ? 'one' : count === 2 ? 'two' : count === 3 ? 'three' : count} ${count === 1 ? one : many}`
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
const DOW = new Intl.DateTimeFormat('en-CA', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' })
export const dayLabel = (date: string) => DOW.format(new Date(`${date}T12:00:00Z`))

/** Grower-facing observations, notable exceptions first; every figure comes from ReportStats. */
export function reportObservations(s: ReportStats, t: Thresholds): Record<'temperature' | 'rh' | 'co2' | 'radiation' | 'irrigation', Observation[]> {
  const week = s.dates.length > 1
  const T = s.temperature, R = s.rh, C = s.co2
  const temperature: Observation[] = []
  if (T.readings === 0) temperature.push({ tone: 'info', text: 'No temperature readings for this period.' })
  else {
    if (T.highReadings > 0) {
      const runs = T.highRuns
        .slice(0, 4)
        .map((r) => `${week ? `${dayLabel(r.date)} ` : ''}${r.from === r.to ? hh(r.from) : `${hh(r.from)}–${hh(r.to)}`}${week || T.highRuns.length > 1 ? ` (${n(r.count, 'reading')})` : ''}`)
        .join('; ')
      temperature.push({
        tone: 'notable',
        text: week
          ? `${cap(n(T.daysReachingHigh, 'day'))} of ${s.dates.length} reached ${t.highTemp} °C, with ${n(T.highReadings, 'hourly reading')} at or above it: ${runs}${T.highRuns.length > 4 ? ' …' : ''}.`
          : `${cap(n(T.highReadings, 'hourly reading'))} at or above ${t.highTemp} °C: ${runs}. The exact time above ${t.highTemp} °C isn’t measured; readings are on the hour.`,
      })
    }
    if (T.lowReadings) temperature.push({ tone: 'notable', text: `${cap(n(T.lowReadings, 'hourly reading'))} below ${t.lowTemp} °C.` })
    const parts = [
      T.dayMean !== null ? `Daytime temperature averaged ${f1(T.dayMean)} °C` : null,
      T.nightMean !== null ? `night ${f1(T.nightMean)} °C` : null,
      T.difference !== null ? `a ${f1(Math.abs(T.difference))} °C ${T.difference >= 0 ? 'day–night difference' : 'night-warmer-than-day difference'}` : null,
    ].filter(Boolean)
    if (parts.length) temperature.push({ tone: 'info', text: `${parts.join(', ')}.` })
    if (T.max && T.min) temperature.push({ tone: 'info', text: `Range ${f1(T.min.value)} °C (${week ? dayLabel(T.min.date) + ' ' : ''}${hh(T.min.hour)}) to ${f1(T.max.value)} °C (${week ? dayLabel(T.max.date) + ' ' : ''}${hh(T.max.hour)}).` })
  }

  const rh: Observation[] = []
  if (R.dayMean === null && R.nightMean === null) rh.push({ tone: 'info', text: 'No humidity readings for this period.' })
  else {
    if (R.highNight > 0) {
      rh.push({
        tone: 'notable',
        text: week && R.nightsWithHigh > 1
          ? `RH exceeded ${t.highRh}% on ${R.nightsWithHigh} of ${R.nights} nights (${n(R.highNight, 'nighttime hourly reading')}). Repeated overnight high humidity can favour condensation, a known Botrytis risk factor; it doesn’t mean disease is present.`
          : `RH exceeded ${t.highRh}% during ${n(R.highNight, 'nighttime hourly reading')}. Overnight high humidity can favour condensation (a Botrytis risk factor); it doesn’t mean disease is present.`,
      })
    }
    if (R.highDay > 0) rh.push({ tone: 'notable', text: `${cap(n(R.highDay, 'daytime hourly reading'))} above ${t.highRh}% RH.` })
    if (R.lowDay > 0)
      rh.push({
        tone: 'notable',
        text: week && R.daysWithLowDay > 1
          ? `Daytime RH fell below ${t.lowDayRh}% on ${R.daysWithLowDay} of ${R.days} days (${n(R.lowDay, 'hourly reading')}).`
          : `${cap(n(R.lowDay, 'daytime hourly reading'))} below ${t.lowDayRh}% RH.`,
      })
    if (R.longestHigh && R.longestHigh.count > 1)
      rh.push({ tone: R.longestHigh.count >= 4 ? 'notable' : 'info', text: `Longest run above ${t.highRh}%: ${R.longestHigh.count} consecutive hourly readings from ${week ? dayLabel(R.longestHigh.date) + ' ' : ''}${hh(R.longestHigh.from)}.` })
    rh.push({ tone: 'info', text: `RH averaged ${R.dayMean !== null ? `${f0(R.dayMean)}% by day` : '— by day'} and ${R.nightMean !== null ? `${f0(R.nightMean)}% at night` : '— at night'}.` })
  }

  const co2: Observation[] = []
  if (C.dayReadings === 0) co2.push({ tone: 'info', text: 'No daytime CO₂ readings for this period.' })
  else {
    if (C.lowDay) co2.push({ tone: 'notable', text: `${cap(n(C.lowDay, 'daytime hourly reading'))} below ${t.lowDayCo2} ppm.` })
    co2.push({ tone: 'info', text: `Daytime CO₂ averaged ${f0(C.dayMean!)} ppm (range ${f0(C.dayMin!)}–${f0(C.dayMax!)} ppm).` })
  }

  const radiation: Observation[] = []
  const Ra = s.radiation
  if (!week) {
    const d = Ra.days[0]
    radiation.push(d.value !== null ? { tone: 'info', text: `Radiation: ${f0(d.value)} J/cm² for the day (23:00 reading, whole greenhouse).` } : { tone: 'notable', text: 'No final radiation for the day (no 23:00 reading in effect).' })
  } else if (Ra.finalDays === 0) radiation.push({ tone: 'notable', text: 'No day in the period has a final radiation reading.' })
  else {
    radiation.push({
      tone: Ra.finalDays < s.dates.length ? 'notable' : 'info',
      text: `Radiation totalled ${f0(Ra.total!)} J/cm² over ${Ra.finalDays} complete day${Ra.finalDays === 1 ? '' : 's'}${Ra.finalDays < s.dates.length ? ` (of ${s.dates.length}; days without a 23:00 reading aren’t included)` : ''}, ${f0(Ra.mean!)} J/cm² a day on average.`,
    })
    if (Ra.finalDays > 1) radiation.push({ tone: 'info', text: `Highest ${dayLabel(Ra.highest!.date)} (${f0(Ra.highest!.value)} J/cm²), lowest ${dayLabel(Ra.lowest!.date)} (${f0(Ra.lowest!.value)} J/cm²).` })
  }

  const irrigation: Observation[] = []
  const I = s.irrigation
  if (!week) {
    const d = I.days[0]
    irrigation.push(d.value !== null ? { tone: 'info', text: `Irrigation: ${f0(d.value)} ml/dripper for the day (23:00 reading, mean of the variety’s zones).` } : { tone: 'notable', text: 'No final irrigation for the day (a zone or the 23:00 reading is missing).' })
  } else if (I.finalDays === 0) irrigation.push({ tone: 'notable', text: 'No day in the period has a final irrigation reading.' })
  else
    irrigation.push({
      tone: I.finalDays < s.dates.length ? 'notable' : 'info',
      text: `Irrigation totalled ${f0(I.total!)} ml/dripper over ${I.finalDays} complete day${I.finalDays === 1 ? '' : 's'}${I.finalDays < s.dates.length ? ` (of ${s.dates.length})` : ''}, ${f0(I.mean!)} ml/dripper a day on average.`,
    })
  if (I.per100J !== null) irrigation.push({ tone: 'info', text: `${f1(I.per100J)} ml/dripper per 100 J/cm² of radiation${week ? ` (over the ${I.per100JDays} day${I.per100JDays === 1 ? '' : 's'} with both complete)` : ''}. Descriptive only: no target is set.` })

  const notableFirst = (xs: Observation[]) => [...xs.filter((x) => x.tone === 'notable'), ...xs.filter((x) => x.tone === 'info')]
  return { temperature: notableFirst(temperature), rh: notableFirst(rh), co2: notableFirst(co2), radiation: notableFirst(radiation), irrigation: notableFirst(irrigation) }
}
