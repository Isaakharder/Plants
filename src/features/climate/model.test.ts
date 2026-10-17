import { describe, expect, it } from 'vitest'
import type { ClimatePoint, ClimateSeries } from '../../lib/database.types'
import {
  combineZones,
  dailyFromPoints,
  exclusionWarnings,
  missingWarning,
  parseAreaShares,
  radiationIncrements,
  radiationWarning,
  weekKey,
  weeklyRows,
  type Assignment,
  type LinePoint,
} from './model'

// 17 Oct 2026 10:00 Toronto = 14:00 UTC.
const T10 = Date.parse('2026-10-17T14:00:00Z') / 1000
const H = 3600
const lp = (t: number, v: number | null): LinePoint => ({ t, v, excluded: false })

describe('radiation increments for charts', () => {
  it('converts the running total hour by hour; a gap or a fall gives no value and is counted', () => {
    const pts: ClimatePoint[] = [
      [T10, 100, 0, []],
      [T10 + H, 160, 0, []],
      // 12:00 missing
      [T10 + 3 * H, 260, 0, []],
      [T10 + 4 * H, 250, 0, []],
      [T10 + 5 * H, 290, 0, []],
    ]
    const r = radiationIncrements(pts)
    expect(r.points.map((p) => p.v)).toEqual([null, 60, null, null, null])
    expect(r.statuses).toMatchObject({ first: 1, ok: 1, gap: 1, decrease: 1, after_decrease: 1 })
    expect(radiationWarning(r.statuses)!.text).toBe('Radiation: 3 hours can’t be converted to an hourly amount (1 after a missing hour, 2 around a fall in the running total).')
    expect(radiationWarning({ ok: 3, reset: 0, gap: 0, decrease: 0, after_decrease: 0, first: 1, missing: 0 })).toBeNull()
  })
})

describe('a planting’s zones combined', () => {
  const zones = new Map<string, LinePoint[]>([
    ['z1', [lp(T10, 20), lp(T10 + H, 22), lp(T10 + 2 * H, null)]],
    ['z2', [lp(T10, 24), lp(T10 + H, 26), lp(T10 + 2 * H, 30)]],
  ])

  it('area-weighted when every zone has a share', () => {
    const a: Assignment[] = [
      { zone_id: 'z1', valid_from: '2026-01-01', valid_until: null, area_share: 0.75 },
      { zone_id: 'z2', valid_from: '2026-01-01', valid_until: null, area_share: 0.25 },
    ]
    const c = combineZones(zones, a)
    expect(c[0]).toMatchObject({ v: 21, method: 'weighted', coverage: 1 })
    // Zone 1 missing: only 25% of the area has a value → no combined value rather than a guess.
    expect(c[2]).toMatchObject({ v: null, method: 'weighted', coverage: 0.25 })
  })

  it('unweighted (labelled) when shares are unknown', () => {
    const a: Assignment[] = [
      { zone_id: 'z1', valid_from: '2026-01-01', valid_until: null, area_share: null },
      { zone_id: 'z2', valid_from: '2026-01-01', valid_until: null, area_share: null },
    ]
    const c = combineZones(zones, a)
    expect(c[1]).toMatchObject({ v: 24, method: 'unweighted', coverage: 1 })
    expect(c[2]).toMatchObject({ v: 30, method: 'unweighted', coverage: 0.5 })
  })

  it('uses only the zones assigned on that day; a zone outside its dates never counts', () => {
    const a: Assignment[] = [
      { zone_id: 'z1', valid_from: '2026-01-01', valid_until: '2026-10-17', area_share: null },
      { zone_id: 'z2', valid_from: '2026-10-17', valid_until: null, area_share: null },
    ]
    // On 17 Oct only z2 is assigned: z1's readings are ignored.
    expect(combineZones(zones, a).map((p) => p.v)).toEqual([24, 26, 30])
    expect(combineZones(zones, [])[0]).toMatchObject({ v: null, method: null })
  })
})

describe('summaries', () => {
  it('daily from hourly points, on greenhouse-local dates, excluding flagged values', () => {
    // 22:00 and 23:00 Toronto on 17 Oct, then 00:00 on 18 Oct.
    const t22 = Date.parse('2026-10-18T02:00:00Z') / 1000
    const days = dailyFromPoints([lp(t22, 20), { t: t22 + H, v: null, excluded: true }, lp(t22 + 2 * H, 18)])
    expect(days).toEqual([
      ['2026-10-17', 1, 20, 20, 20, 1],
      ['2026-10-18', 1, 18, 18, 18, 0],
    ])
  })

  it('weekly rows weight each day by its hours', () => {
    const rows = weeklyRows([
      ['2026-10-12', 24, 20, 15, 25, 0],
      ['2026-10-13', 12, 26, 18, 30, 2],
      ['2026-10-19', 24, 21, 16, 26, 0],
    ])
    expect(rows.map((r) => [r.label, r.hours, r.mean, r.min, r.max, r.excluded])).toEqual([
      ['W42 2026', 36, 22, 15, 30, 2],
      ['W43 2026', 24, 21, 16, 26, 0],
    ])
    expect(weekKey('2027-01-01')).toMatchObject({ year: 2026, week: 53 })
  })
})

describe('data-quality warnings', () => {
  it('names the zones and reasons of excluded readings', () => {
    const series: ClimateSeries[] = [
      { zone_id: 'z7', metric: 'ec', unit: 'mS/cm', points: [[T10, 0, 1, ['ec_zero_suspect']], [T10 + H, 0, 1, ['ec_zero_suspect']]] },
      ...['z1', 'z2', 'z3', 'z4'].map((z) => ({ zone_id: z, metric: 'ph', unit: 'pH', points: [[T10, 0, 1, ['ph_zero_sentinel']]] as ClimatePoint[] })),
      { zone_id: 'z1', metric: 'air_temperature', unit: '°C', points: [[T10, 21, 0, []]] },
    ]
    const w = exclusionWarnings(series, (id) => `Zone ${id.slice(1)}`)
    expect(w.map((x) => x.text)).toEqual([
      'EC: Zone 7 reported 0.0 EC (suspicious) — 2 readings excluded.',
      'pH: 4 zones reported 0.0 pH (sensor not reporting) — 4 readings excluded.',
    ])
  })

  it('summarises missing hours, longest gaps first', () => {
    const w = missingWarning([
      ['2026-10-17T15:00:00Z', '2026-10-17T16:00:00Z', 1],
      ['2026-09-15T20:00:00Z', '2026-09-18T05:00:00Z', 57],
    ])
    expect(w!.text).toBe('58 hours without data: 09/15 16:00 – 09/18 00:00 (57 h); 10/17 11:00.')
    expect(missingWarning([])).toBeNull()
  })
})

describe('area shares', () => {
  it('all blank, or all given and adding up to 100', () => {
    expect(parseAreaShares(['', ' '])).toEqual({ shares: [null, null] })
    expect(parseAreaShares(['60', '40'])).toEqual({ shares: [0.6, 0.4] })
    expect(parseAreaShares(['33.33', '33.33', '33,34'])).toEqual({ shares: [0.3333, 0.3333, 0.3334] })
    expect(parseAreaShares(['60', ''])).toEqual({ error: 'Give an area % for every zone, or leave them all blank.' })
    expect(parseAreaShares(['60', '30'])).toEqual({ error: 'Area % add up to 90, not 100.' })
    expect(parseAreaShares(['0', '100'])).toMatchObject({ error: expect.any(String) })
  })
})
