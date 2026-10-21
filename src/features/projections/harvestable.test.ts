import { describe, expect, it } from 'vitest'
import type { WeeklyPlantDataRow } from '../../lib/database.types'
import { harvestableArea, harvestableKgTitle, harvestableWeek } from './harvestable'

const week = (iso_week: number, sampled_stems: number, provisional = false): WeeklyPlantDataRow => ({
  iso_week,
  sampled_stems,
  sampled_m2: sampled_stems ? sampled_stems / 7 : null,
  new_sets: 0,
  new_breakers: 0,
  new_harvested: 0,
  sets_per_m2: null,
  breakers_per_m2: null,
  harvested_per_m2: null,
  is_sampled: sampled_stems > 0,
  is_baseline: false,
  is_provisional: provisional,
})
// 7 stems/m²; W42 fully sampled (70 stems = 10 m²); W43 in progress, 7 stems visited so far.
const weeks = [week(41, 70), week(42, 70), week(43, 7, true), week(44, 0)]
const afw = new Map([[42, 200]])
const afwOf = (w: number) => afw.get(w) ?? null

describe('harvestableArea', () => {
  it('uses the last sampled week for the week in progress (a midweek count comes before the walkthrough)', () => {
    expect(harvestableArea(weeks, 43)).toEqual({ areaM2: 10, week: 42 })
  })
  it('uses the week’s own area once it is over', () => {
    expect(harvestableArea([...weeks.slice(0, 2), week(43, 63)], 43)).toEqual({ areaM2: 9, week: 43 })
  })
})

describe('harvestableWeek', () => {
  it('projects the marked peppers into their own week, with that week’s or the last AFW', () => {
    const h = harvestableWeek({ iso_week: 43, harvestable: 20, harvested_same_week: 0 }, weeks, afwOf, 1000)
    // 20 ÷ 10 m² = 2/m² × 1,000 m² × 200 g = 400 kg
    expect(h).toEqual(expect.objectContaining({ week: 43, marked: 20, perM2: 2, afwG: 200, afwWeek: 42, kg: 400, remaining: 20, remainingKg: 400 }))
  })

  it('Harvestable → Harvested: picked peppers are not counted again in the week’s projection', () => {
    const h = harvestableWeek({ iso_week: 43, harvestable: 20, harvested_same_week: 5 }, weeks, afwOf, 1000)
    expect(h.kg).toBe(400)
    expect(h.remaining).toBe(15)
    expect(h.remainingKg).toBe(300)
    // Picked kg (5 harvested ÷ 10 m² × 1,000 × 200 g = 100 kg) + 300 still to pick = 400, not 500.
    expect(harvestableKgTitle(h, 1000, 100)).toContain('Picked 100 kg + still to pick 300 kg = 400 kg')
  })

  it('without an AFW or a sampled week, no kg is invented', () => {
    expect(harvestableWeek({ iso_week: 43, harvestable: 20, harvested_same_week: 0 }, weeks, () => null, 1000).kg).toBeNull()
    expect(harvestableWeek({ iso_week: 43, harvestable: 20, harvested_same_week: 0 }, [week(43, 0, true)], afwOf, 1000).perM2).toBeNull()
  })
})
