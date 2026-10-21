import { describe, expect, it } from 'vitest'
import * as model from './model'
import {
  niceTicks,
  valueRange,
  missingWarning,
  parseAreaShares,
} from './model'


describe('data-quality warnings', () => {
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

describe('chart axis', () => {
  it('values equal but for floating-point noise give a sane axis (no endless ticks)', () => {
    const r = valueRange([2.6, 2.6000000000000005, null, 2.6])
    expect(r.yMax - r.yMin).toBeGreaterThan(1)
    expect(niceTicks(2.6, 2.6000000000000005)).toEqual([2.6])
    expect(niceTicks(r.yMin, r.yMax).length).toBeLessThanOrEqual(12)
  })

  it('ordinary ranges get round ticks; bars start at zero', () => {
    expect(niceTicks(18.2, 24.9)).toEqual([20, 22, 24])
    expect(valueRange([12, 96], true).yMin).toBe(0)
    expect(niceTicks(0, 1e-300).length).toBeLessThanOrEqual(12)
    expect(niceTicks(NaN, 1)).toEqual([])
    expect(valueRange([])).toEqual({ yMin: 0, yMax: 1 })
  })
})

describe('the five measurements', () => {
  it('uses radiation from column B (Zone 1) only, and no drain, EC or pH', () => {
    const { isUsedMeasurement } = model
    expect(['air_temperature', 'relative_humidity', 'co2', 'irrigation_cumulative'].every((m) => isUsedMeasurement(m, 'Zone 7'))).toBe(true)
    expect(isUsedMeasurement('radiation_sum', 'Zone 1')).toBe(true)
    expect(isUsedMeasurement('radiation_sum', 'Zone 15')).toBe(false)
    expect(['drain_percentage', 'ec', 'ph', 'group_activation_time', 'unknown'].some((m) => isUsedMeasurement(m, 'Zone 1'))).toBe(false)
  })
})
