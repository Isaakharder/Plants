import { describe, expect, it } from 'vitest'
import { formatDate, isIsoDate } from '../../lib/dates'
import { formatTwoDecimals, parseNumberInput } from '../../lib/format'
import { cropToForm, validateCropForm, type CropFormValues } from './cropValidation'
import { cropDescription, cropStatus, stemsPerM2 } from './model'
import { formatTiming, parseAfwGrams, parsePercent, parseTiming } from './pepperTypes'

const cadalora: CropFormValues = {
  name: '  Cadalora ',
  color: 'red',
  planting_date: '2025-12-08',
  pullout_date: '2026-12-05',
  area_m2: '31,114',
  picking_stems: '76,000',
  pepper_type_id: 'bell-type-id',
  sets_provisional_survival: '',
  sets_provisional_timing: '',
}

describe('validateCropForm', () => {
  it('accepts the Cadalora example and normalizes it', () => {
    expect(validateCropForm(cadalora)).toEqual({
      data: { name: 'Cadalora', color: 'red', planting_date: '2025-12-08', pullout_date: '2026-12-05', area_m2: 31114, picking_stems: 76000, pepper_type_id: 'bell-type-id', sets_provisional_survival: null, sets_provisional_timing: null },
    })
  })

  it('reports every missing field', () => {
    const result = validateCropForm({ name: '', color: '', planting_date: '', pullout_date: '', area_m2: '', picking_stems: '', pepper_type_id: '', sets_provisional_survival: '', sets_provisional_timing: '' })
    expect('errors' in result && Object.keys(result.errors).sort()).toEqual(
      ['area_m2', 'color', 'name', 'pepper_type_id', 'picking_stems', 'planting_date', 'pullout_date'],
    )
  })

  it('rejects pullout on or before planting', () => {
    const result = validateCropForm({ ...cadalora, pullout_date: '2025-12-08' })
    expect('errors' in result && result.errors.pullout_date).toMatch(/after/)
  })

  it('rejects non-positive, non-numeric and fractional stems', () => {
    for (const [value, msg] of [['0', /greater/], ['abc', /number/], ['10.5', /whole/], ['-5', /number/]] as const) {
      const result = validateCropForm({ ...cadalora, picking_stems: value })
      expect('errors' in result && result.errors.picking_stems).toMatch(msg)
    }
  })

  it('allows fractional area', () => {
    expect(validateCropForm({ ...cadalora, area_m2: '1,234.5' })).toHaveProperty('data.area_m2', 1234.5)
  })
})

describe('cropStatus', () => {
  const crop = { planting_date: '2025-12-08', pullout_date: '2026-12-05' }
  it('is planned before planting', () => expect(cropStatus(crop, '2025-12-07')).toBe('planned'))
  it('is active on planting day', () => expect(cropStatus(crop, '2025-12-08')).toBe('active'))
  it('is active on pullout day', () => expect(cropStatus(crop, '2026-12-05')).toBe('active'))
  it('is finished after pullout', () => expect(cropStatus(crop, '2026-12-06')).toBe('finished'))
})

describe('dates and numbers', () => {
  it('formats calendar dates without time-zone shift', () => expect(formatDate('2025-12-08')).toBe('Dec 8, 2025'))
  it('rejects impossible dates', () => {
    expect(isIsoDate('2026-02-30')).toBe(false)
    expect(isIsoDate('2026-02-28')).toBe(true)
  })
  it('parses grouped numbers', () => {
    expect(parseNumberInput('31,114')).toBe(31114)
    expect(parseNumberInput('1.2.3')).toBeNaN()
  })
})

describe('stemsPerM2', () => {
  it('divides picking stems by area', () => {
    expect(formatTwoDecimals(stemsPerM2({ picking_stems: 80000, area_m2: 12000 }))).toBe('6.67')
    expect(formatTwoDecimals(stemsPerM2({ picking_stems: 76000, area_m2: 31114 }))).toBe('2.44')
  })

  it('always shows two decimals', () => {
    expect(formatTwoDecimals(stemsPerM2({ picking_stems: 24000, area_m2: 12000 }))).toBe('2.00')
  })
})

describe('pepper types', () => {
  it('requires a pepper type: never defaulted', () => {
    const result = validateCropForm({ ...cadalora, pepper_type_id: '' })
    expect('errors' in result && result.errors.pepper_type_id).toMatch(/pepper type/)
  })

  it('describes a variety by its colour and pepper type', () => {
    expect(cropDescription('red', 'Bell Pepper')).toBe('Red Bell Pepper')
    expect(cropDescription('red', 'Long Pointed Pepper')).toBe('Red Long Pointed Pepper')
    expect(cropDescription('other', 'Long Pointed Pepper')).toBe('Long Pointed Pepper')
  })

  it('reads and writes provisional timing as weeks : %', () => {
    const bell = [0, 0, 0, 0, 0, 0.2, 0.3, 0.3, 0.2, 0, 0]
    expect(formatTiming(bell)).toBe('5:20, 6:30, 7:30, 8:20')
    expect(parseTiming('5:20, 6:30, 7:30, 8:20')).toEqual({ shares: bell })
    expect(parseTiming('')).toEqual({ shares: null })
    expect(parseTiming('5:20, 6:30')).toMatchObject({ error: expect.stringMatching(/50%/) })
    expect(parseTiming('11:100')).toMatchObject({ error: expect.stringMatching(/up to 10/) })
    expect(parseTiming('6:50, 6:50')).toMatchObject({ error: expect.stringMatching(/twice/) })
  })

  it('reads survival % and AFW, empty as not configured', () => {
    expect(parsePercent('55')).toEqual({ value: 0.55 })
    expect(parsePercent('')).toEqual({ value: null })
    expect(parsePercent('0')).toMatchObject({ error: expect.any(String) })
    expect(parseAfwGrams('125')).toEqual({ value: 125 })
    expect(parseAfwGrams('')).toEqual({ value: null })
  })
})

describe('variety forecasting overrides', () => {
  it('are optional: empty inherits the pepper type (null)', () => {
    const result = validateCropForm(cadalora)
    expect('data' in result && [result.data.sets_provisional_survival, result.data.sets_provisional_timing]).toEqual([null, null])
  })

  it('store a survival % and a timing distribution that adds up to 100%', () => {
    const result = validateCropForm({ ...cadalora, sets_provisional_survival: '55', sets_provisional_timing: '6:40, 7:60' })
    expect('data' in result && result.data.sets_provisional_survival).toBe(0.55)
    expect('data' in result && result.data.sets_provisional_timing).toEqual([0, 0, 0, 0, 0, 0, 0.4, 0.6, 0, 0, 0])
  })

  it('refuse invalid values so they cannot be saved', () => {
    const bad = validateCropForm({ ...cadalora, sets_provisional_survival: '150', sets_provisional_timing: '6:40, 7:50' })
    expect('errors' in bad && bad.errors.sets_provisional_survival).toMatch(/percentage/)
    expect('errors' in bad && bad.errors.sets_provisional_timing).toMatch(/90%/)
    for (const timing of ['six:100', '11:100', '6:50, 6:50']) {
      const r = validateCropForm({ ...cadalora, sets_provisional_timing: timing })
      expect('errors' in r && r.errors.sets_provisional_timing).toBeTruthy()
    }
  })

  it('round-trip a saved override through the edit form', () => {
    const crop = { name: 'X', color: 'red', planting_date: '2026-01-01', pullout_date: '2026-12-01', area_m2: 100, picking_stems: 700, pepper_type_id: 't', sets_provisional_survival: 0.55, sets_provisional_timing: [0, 0, 0, 0, 0, 0, 0.4, 0.6, 0, 0, 0] }
    const form = cropToForm(crop as never)
    expect([form.sets_provisional_survival, form.sets_provisional_timing]).toEqual(['55', '6:40, 7:60'])
    const again = validateCropForm(form)
    expect('data' in again && [again.data.sets_provisional_survival, again.data.sets_provisional_timing]).toEqual([0.55, crop.sets_provisional_timing])
  })
})
