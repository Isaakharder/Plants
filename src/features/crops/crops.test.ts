import { describe, expect, it } from 'vitest'
import { formatDate, isIsoDate } from '../../lib/dates'
import { formatTwoDecimals, parseNumberInput } from '../../lib/format'
import { validateCropForm, type CropFormValues } from './cropValidation'
import { cropStatus, stemsPerM2 } from './model'

const cadalora: CropFormValues = {
  name: '  Cadalora ',
  color: 'red',
  planting_date: '2025-12-08',
  pullout_date: '2026-12-05',
  area_m2: '31,114',
  picking_stems: '76,000',
}

describe('validateCropForm', () => {
  it('accepts the Cadalora example and normalizes it', () => {
    expect(validateCropForm(cadalora)).toEqual({
      data: { name: 'Cadalora', color: 'red', planting_date: '2025-12-08', pullout_date: '2026-12-05', area_m2: 31114, picking_stems: 76000 },
    })
  })

  it('reports every missing field', () => {
    const result = validateCropForm({ name: '', color: '', planting_date: '', pullout_date: '', area_m2: '', picking_stems: '' })
    expect('errors' in result && Object.keys(result.errors).sort()).toEqual(
      ['area_m2', 'color', 'name', 'picking_stems', 'planting_date', 'pullout_date'],
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
