import { describe, expect, it } from 'vitest'
import { MAX_AGE, PROVISIONAL_ASSUMPTIONS, setsPotential, usableSets, varietyParameters, type Cohort, type SetsWeekInput } from './sets'

const label = (i: number) => `W${i}`
const ages = (byAge: Record<number, number>) => Array.from({ length: MAX_AGE + 1 }, (_, d) => byAge[d] ?? 0)

/** A cohort set in week `setIndex`: harvested and lost by age, and peppers still on the plant. */
function cohort(setIndex: number, harvested: Record<number, number>, lost: Record<number, number>, onPlant = 0, isBaseline = false): Cohort {
  const h = ages(harvested)
  const l = ages(lost)
  const sets = h.reduce((s, v) => s + v, 0) + l.reduce((s, v) => s + v, 0) + onPlant
  return { setIndex, sets, harvestedByAge: h, lostByAge: l, resolvedLater: 0, onPlant, isBaseline }
}

// Weeks 1–6: 100 peppers each; 30 lost at age 1, 10 at age 2; 40 harvested at 7 weeks, 20 at 8.
const completed = () => Array.from({ length: 6 }, (_, i) => cohort(i + 1, { 7: 40, 8: 20 }, { 1: 30, 2: 10 }))

const week = (index: number, over: Partial<SetsWeekInput> = {}): SetsWeekInput => ({
  index,
  perM2: 10,
  isBaseline: false,
  newSets: 100,
  catchupSets: 0,
  firstSeenSet: 50,
  coverage: 1,
  inProgress: false,
  ...over,
})

const base = { originIndex: 20, areaM2: 1000, afw: [{ year: 1970, week: 2, afwG: 200 }], weeksAhead: 9, label }

describe('varietyParameters', () => {
  it('measures survival, timing and survival after each age from the variety’s own completed cohorts', () => {
    const p = varietyParameters(completed(), 20, label)
    expect(p.survival).toMatchObject({ kind: 'measured' })
    expect(p.survival.value).toBeCloseTo(0.6)
    expect(p.timing.value[7]).toBeCloseTo(2 / 3)
    expect(p.timing.value.reduce((s, v) => s + v, 0)).toBeCloseTo(1)
    // Losses happen by age 2: a pepper still on the plant at age 3 is always harvested.
    expect(p.afterAge[0]!.survival).toBeCloseTo(0.6)
    expect(p.afterAge[1]!.survival).toBeCloseTo(60 / 70)
    expect(p.afterAge[3]!.survival).toBeCloseTo(1)
    expect(p.afterAge[3]!.timing[7]).toBeCloseTo(2 / 3)
  })

  it('completes a cohort when its harvest window is over, not when its fruit happens to resolve early', () => {
    const p = varietyParameters([...completed(), cohort(15, {}, { 1: 50 })], 20, label)
    expect(p.survival.value).toBeCloseTo(0.6)
    expect(p.incomplete.map((c) => c.setIndex)).toEqual([15])
  })

  it('uses stated provisional assumptions without enough completed cohorts (never another variety’s)', () => {
    const p = varietyParameters(completed().slice(0, 2), 20, label)
    expect(p.survival).toMatchObject({ kind: 'provisional', value: PROVISIONAL_ASSUMPTIONS.survival })
    expect(p.timing).toMatchObject({ kind: 'provisional', value: PROVISIONAL_ASSUMPTIONS.timing })
    expect(p.survival.basis).toMatch(/2 completed cohorts/)
    expect(varietyParameters([], 20, label, { provisionalSurvival: 0.45 }).survival.value).toBe(0.45)
  })

  it('ignores the baseline cohort and cohorts set after the origin', () => {
    const p = varietyParameters([...completed(), cohort(0, { 7: 500 }, {}, 0, true), cohort(30, { 7: 100 }, {})], 20, label)
    expect(p.survival.value).toBeCloseTo(0.6)
  })
})

describe('usableSets', () => {
  it('drops the baseline, unsampled and partly sampled weeks (missing, not zero) and catch-up peppers', () => {
    const weeks = usableSets([
      week(1, { isBaseline: true }),
      week(2, { perM2: null }),
      week(3, { coverage: 0.5 }),
      week(4, { catchupSets: 20 }),
      week(5, { coverage: 0.6, inProgress: true }),
    ])
    expect(weeks.map((w) => w.status)).toEqual(['baseline', 'not_sampled', 'partly_sampled', 'used', 'in_progress'])
    expect(weeks.map((w) => w.perM2)).toEqual([null, null, null, 8, 10])
  })

  it('flags a week whose new sets were nearly all first recorded already set, and counts it only when included', () => {
    const rows = [week(6, { firstSeenSet: 95 }), week(7, { newSets: 10, firstSeenSet: 10 })]
    expect(usableSets(rows).map((w) => [w.status, w.perM2])).toEqual([
      ['possible_catchup', null],
      ['used', 10], // too few sets to judge
    ])
    expect(usableSets(rows, true)[0]).toMatchObject({ status: 'possible_catchup', perM2: 10 })
  })
})

describe('setsPotential: cohort accounting', () => {
  it('keeps observed outcomes and never counts a loss twice (provisional survival budget)', () => {
    // Week 18 (age 2): 100 sampled peppers, 30 already lost, 70 on the plant. Assumed survival 60%:
    // 40 losses in all, 30 already seen, so 10 more: 60 harvested, not 70 × 60% = 42.
    const r = setsPotential({ ...base, cohorts: [cohort(18, {}, { 1: 30 }, 70)], sets: [week(18)] })
    const [p] = r.potential
    const k = (10 * 1000) / 100 // crop peppers per sampled pepper
    expect(p.set).toBeCloseTo(100 * k)
    expect(p.lost).toBeCloseTo(30 * k)
    expect(p.onPlant).toBeCloseTo(70 * k)
    expect(p.futureHarvest).toBeCloseTo(60 * k)
    expect(p.furtherLosses).toBeCloseTo(10 * k)
    expect(p.survivalBasis).toBe('survival budget')
  })

  it('never expects more than harvested + still on the plant, nor further losses below zero', () => {
    const many = setsPotential({ ...base, cohorts: [cohort(18, {}, { 1: 60 }, 40)], sets: [week(18)] }).potential[0]
    expect(many.futureHarvest).toBeCloseTo(many.onPlant) // more lost than assumed: the rest is all expected to be harvested
    expect(many.furtherLosses).toBeCloseTo(0)
    const picked = setsPotential({ ...base, cohorts: [cohort(12, { 7: 70 }, {}, 30)], sets: [week(12)] }).potential[0]
    expect(picked.futureHarvest).toBe(0) // already harvested beyond the assumed survival
    expect(picked.expectedHarvest).toBeCloseTo(picked.harvested)
  })

  it('treats peppers still on the plant as immature, not lost', () => {
    const p = setsPotential({ ...base, cohorts: [cohort(20, {}, {}, 100)], sets: [week(20)] }).potential[0]
    expect(p.lost).toBe(0)
    expect(p.futureHarvest).toBeCloseTo(0.6 * p.set)
  })

  it('uses the measured survival of peppers still on the plant at their age', () => {
    // Measured: no losses after age 2, so 70 peppers on the plant at age 4 are all expected to be harvested.
    const r = setsPotential({ ...base, cohorts: [...completed(), cohort(16, {}, { 1: 30 }, 70)], sets: [week(16)] })
    const [p] = r.potential
    expect(p.survivalBasis).toBe('measured at age')
    expect(p.stillOnPlantSurvival).toBeCloseTo(1)
    expect(p.futureHarvest).toBeCloseTo(p.onPlant)
  })

  it('spreads each future pepper over the harvest weeks once, and gives kg at the AFW', () => {
    const r = setsPotential({ ...base, cohorts: [cohort(18, {}, { 1: 30 }, 70)], sets: [week(18)] })
    const [p] = r.potential
    const fruit = [...p.byWeek.values()].reduce((s, v) => s + v.fruit, 0)
    expect(fruit).toBeCloseTo(p.futureHarvest)
    expect(p.futureKg).toBeCloseTo((p.futureHarvest * 200) / 1000)
    expect(setsPotential({ ...base, afw: [], cohorts: [cohort(18, {}, {}, 100)], sets: [week(18)] }).potential[0].futureKg).toBeNull() // never a guessed AFW
  })

  it('keeps Sets-based harvest due next week out of the outlook (the Breakers week)', () => {
    // Age 7 at the origin: provisional timing leaves 8 weeks (next week) only.
    const r = setsPotential({ ...base, cohorts: [cohort(13, {}, {}, 100)], sets: [week(13)] })
    expect(r.dueNextWeek.fruit).toBeCloseTo(r.potential[0].futureHarvest)
    expect(r.outlook[0].targetIndex).toBe(22)
    expect(r.outlook.every((w) => w.fruit === 0)).toBe(true)
  })

  it('moves fruit older than the timing to the following week instead of losing it', () => {
    const r = setsPotential({ ...base, cohorts: [cohort(10, {}, {}, 100)], sets: [week(10)] }) // age 10, past the 5–8 week assumption
    expect(r.dueNextWeek.fruit).toBeCloseTo(r.potential[0].futureHarvest)
    expect(r.potential[0].futureHarvest).toBeGreaterThan(0)
  })

  it('reports incomplete coverage for harvest weeks with unrecorded set weeks', () => {
    const r = setsPotential({ ...base, cohorts: [cohort(20, {}, {}, 100)], sets: [week(20)] })
    const w27 = r.outlook.find((w) => w.targetIndex === 27)! // 7 weeks after week 20; its 5-, 6- and 8-week shares are unrecorded weeks
    expect(w27.coverage).toBeCloseTo(0.3)
    expect(w27.fruit).toBeGreaterThan(0)
  })
})
