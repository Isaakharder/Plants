import { describe, expect, it } from 'vitest'
import { DEFAULT_THRESHOLDS, addDays, computeReport, hoursInDay, parseClock, reportObservations, type Daylight } from './reports'
import type { VarietyDay, VarietyHour } from './varietyClimate'

const TZ = 'America/Toronto'
// Toronto is UTC−4 in October.
const utc = (date: string, h: number) => new Date(Date.parse(`${date}T00:00:00Z`) + (h + 4) * 3_600_000).toISOString()
const hour = (date: string, h: number, metric: VarietyHour['metric'], value: number | null): VarietyHour => ({
  hour_utc: utc(date, h), local_date: date, local_hour: h, metric, value, method: 'mean', zones_assigned: 6, zones_used: 6, coverage: 1, inputs: [],
})
const day = (date: string, metric: VarietyDay['metric'], value: number | null, status: VarietyDay['status'] = value === null ? 'incomplete' : 'final'): VarietyDay => ({
  local_date: date, metric, value, status, hours: 24, min_value: null, max_value: null, running_value: null, running_hour: null, restart_hour: null, method: 'mean', zones_assigned: 6, min_coverage: 1,
})
// 20 Oct: sunrise 07:47, sunset 18:43 (the climate computer's rows).
const daylight = (dates: string[]): Daylight => new Map(dates.map((d) => [d, { sunrise: 7 * 60 + 47, sunset: 18 * 60 + 43 }]))

/** A day: 18 °C at night, 22 °C by day, with optional hot hours; RH 80 by day (65 at noon), 90 at 00–03; CO₂ 600 day / 400 night. */
function dayHours(date: string, hot: Record<number, number> = {}, skip: number[] = []): VarietyHour[] {
  const out: VarietyHour[] = []
  for (let h = 0; h < 24; h++) {
    if (skip.includes(h)) continue
    const isDay = h >= 8 && h <= 18
    out.push(hour(date, h, 'air_temperature', hot[h] ?? (isDay ? 22 : 18)))
    out.push(hour(date, h, 'relative_humidity', h <= 3 ? 90 : h === 12 ? 65 : 80))
    out.push(hour(date, h, 'co2', isDay ? 600 : 400))
  }
  return out
}

describe('report basics', () => {
  it('reads the climate computer clock rows and knows day lengths', () => {
    expect(parseClock('Real time - 07:48')).toBe(468)
    expect(parseClock('Real time - --:--')).toBeNull()
    expect(hoursInDay('2026-10-20', TZ)).toBe(24)
    expect(hoursInDay('2026-11-01', TZ)).toBe(25) // clocks go back
    expect(addDays('2026-10-01', -1)).toBe('2026-09-30')
  })
})

describe('Yesterday', () => {
  const D = '2026-10-20'
  const s = computeReport([D], dayHours(D, { 13: 28.5, 14: 29 }), [day(D, 'radiation_sum', 1551.6), day(D, 'irrigation_cumulative', 1242)], daylight([D]), DEFAULT_THRESHOLDS, TZ)
  const o = reportObservations(s, DEFAULT_THRESHOLDS)

  it('splits day and night by the climate computer’s sunrise/sunset, not the radiation restart', () => {
    // 08:00–18:00 are daytime (07:00 is before 07:47; 18:00 is before 18:43).
    expect(s.temperature.dayMean).toBeCloseTo((9 * 22 + 28.5 + 29) / 11)
    expect(s.temperature.nightMean).toBe(18)
    expect(s.co2).toMatchObject({ dayMean: 600, dayMin: 600, dayMax: 600, lowDay: null, dayReadings: 11 })
  })

  it('counts hourly readings at or above thresholds and says when', () => {
    expect(s.temperature).toMatchObject({ highReadings: 2, highDayReadings: 2, daysReachingHigh: 1, highRuns: [{ date: D, from: 13, to: 14, count: 2 }] })
    expect(o.temperature[0]).toEqual({ tone: 'notable', text: 'Two hourly readings at or above 28 °C: 13:00–14:00. The exact time above 28 °C isn’t measured; readings are on the hour.' })
  })

  it('reports overnight high RH without claiming disease, and low daytime RH', () => {
    expect(s.rh).toMatchObject({ highNight: 4, highDay: 0, lowDay: 1, longestHigh: { count: 4, date: D, from: 0 } })
    expect(o.rh[0].text).toBe('RH exceeded 88% during 4 nighttime hourly readings. Overnight high humidity can favour condensation (a Botrytis risk factor); it doesn’t mean disease is present.')
    expect(o.rh.map((x) => x.text)).toContain('One daytime hourly reading below 70% RH.')
    // Routine confirmations are left out: only exceptions and the averages.
    expect(o.co2.map((x) => x.text)).toEqual(['Daytime CO₂ averaged 600 ppm (range 600–600 ppm).'])
  })

  it('uses the 23:00 finals for radiation and irrigation and relates them descriptively', () => {
    expect(o.radiation[0].text).toBe('Radiation: 1,552 J/cm² for the day (23:00 reading, whole greenhouse).')
    expect(o.irrigation.map((x) => x.text)).toEqual([
      'Irrigation: 1,242 ml/dripper for the day (23:00 reading, mean of the variety’s zones).',
      '80.0 ml/dripper per 100 J/cm² of radiation. Descriptive only: no target is set.',
    ])
    expect(s.completeness[0]).toMatchObject({ hoursRecorded: 24, expectedHours: 24, complete: true })
  })
})

describe('Last 7 Days', () => {
  const dates = Array.from({ length: 7 }, (_, i) => addDays('2026-10-14', i))
  const hours = dates.flatMap((d, i) => dayHours(d, i % 3 === 0 ? { 14: 28 } : {}, i === 2 ? [5, 6, 7] : []))
  const days = dates.flatMap((d, i) => [day(d, 'radiation_sum', i === 4 ? null : 1000 + i * 100), day(d, 'irrigation_cumulative', i === 4 ? null : 900)])
  const s = computeReport(dates, hours, days, daylight(dates), DEFAULT_THRESHOLDS, TZ)
  const o = reportObservations(s, DEFAULT_THRESHOLDS)

  it('says how many of seven days are complete, and why', () => {
    expect(s.completeDays).toBe(5) // one day missing 3 hourly files, one missing its 23:00 finals
    expect(s.completeness.find((c) => c.date === dates[2])).toMatchObject({ hoursRecorded: 21, complete: false })
    expect(s.completeness.find((c) => c.date === dates[4])).toMatchObject({ radiationFinal: false, complete: false })
  })

  it('reports recurring patterns: days reaching the high temperature, nights with high RH', () => {
    expect(o.temperature[0].text).toMatch(/^Three days of 7 reached 28 °C, with three hourly readings at or above it/)
    expect(o.rh[0].text).toMatch(/^RH exceeded 88% on 7 of 7 nights/)
    expect(o.rh.map((x) => x.text)).toContain('Daytime RH fell below 70% on 7 of 7 days (7 hourly readings).')
  })

  it('adds up final radiation days only, never snapshots, and names the extremes', () => {
    expect(s.radiation).toMatchObject({ finalDays: 6, total: 1000 + 1100 + 1200 + 1300 + 1500 + 1600, highest: { date: dates[6], value: 1600 }, lowest: { date: dates[0], value: 1000 } })
    expect(o.radiation[0]).toEqual({ tone: 'notable', text: 'Radiation totalled 7,700 J/cm² over 6 complete days (of 7; days without a 23:00 reading aren’t included), 1,283 J/cm² a day on average.' })
    expect(s.irrigation).toMatchObject({ finalDays: 6, total: 5400, per100JDays: 6 })
  })

  it('never turns missing readings into zeros', () => {
    const empty = computeReport(dates, [], [], new Map(), DEFAULT_THRESHOLDS, TZ)
    expect(empty.temperature.dayMean).toBeNull()
    expect(empty.radiation.total).toBeNull()
    expect(reportObservations(empty, DEFAULT_THRESHOLDS).temperature[0].text).toBe('No temperature readings for this period.')
  })
})
