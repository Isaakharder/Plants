import { describe, expect, it } from 'vitest'
import { analysesInEffect, bandOf, bandSummaries, evaluate, progressionPoints, type ColourAnalysis, type ColourMeasurement, type DatedHarvest } from './colourProgression'
import type { StudyClimate } from './maturation'

const TZ = 'America/Toronto'
// 20 °C every hour, 1,000 J/cm² every day, 1–31 October.
const climate: StudyClimate = { daily: new Map(), radiationFinal: new Map() }
for (let d = 1; d <= 31; d++) {
  const date = `2026-10-${String(d).padStart(2, '0')}`
  climate.daily.set(date, { temp: { mean: 20, hours: 24 } })
  climate.radiationFinal.set(date, 1000)
}

describe('analysesInEffect', () => {
  it('keeps the newest estimate by a person over any automatic one', () => {
    const a = (id: string, obs: string, kind: ColourAnalysis['kind'], pct: number, at: string): ColourAnalysis =>
      ({ id, node_observation_id: obs, kind, combined_percent: pct, confidence: kind === 'automatic' ? 0.8 : null, supersedes_id: kind === 'correction' ? 'x' : null, created_at: at })
    const m = analysesInEffect([
      a('1', 'o1', 'automatic', 40, '2026-10-12T19:00:00Z'),
      a('2', 'o1', 'manual', 35, '2026-10-12T20:00:00Z'),
      a('3', 'o1', 'automatic', 60, '2026-10-13T08:00:00Z'), // a newer automatic run doesn't override the person
      a('4', 'o2', 'automatic', 20, '2026-10-12T19:00:00Z'),
      a('5', 'o2', 'automatic', 25, '2026-10-12T21:00:00Z'),
      a('6', 'o3', 'manual', 50, '2026-10-12T19:00:00Z'),
      a('7', 'o3', 'correction', 55, '2026-10-12T19:30:00Z'),
    ])
    expect([...m].map(([k, v]) => `${k}:${v.combined_percent}`).sort()).toEqual(['o1:35', 'o2:25', 'o3:55'])
  })
})

const meas = (node: string, stem: string, at: string, percent: number): ColourMeasurement => ({ node, stem, observationId: `${node}-${at}`, at, percent, byPerson: true, confidence: null })

describe('progressionPoints', () => {
  it('pairs each measurement with its fruit’s dated harvest and the climate in between; no date is guessed', () => {
    const harvests: DatedHarvest[] = [{ node: 'n1', harvestDate: '2026-10-14', status: 'inferred', minColour: 85 }]
    const points = progressionPoints(
      [
        meas('n1', 's1', '2026-10-05T19:00:00Z', 10), // a week before
        meas('n1', 's1', '2026-10-12T19:30:00Z', 60), // at the inspection after the 12th's harvest
        meas('n2', 's1', '2026-10-12T19:30:00Z', 40), // no dated harvest: left out
        meas('n1', 's1', '2026-10-15T15:00:00Z', 100), // after its harvest: left out
      ],
      harvests,
      climate,
      TZ,
    )
    expect(points.map((p) => [p.date, p.percent, p.toHarvest.days, p.toHarvest.degreeDays, p.toHarvest.radiation, p.lastBeforeHarvest])).toEqual([
      ['2026-10-05', 10, 9, 180, 9000, false],
      ['2026-10-12', 60, 2, 40, 2000, true],
    ])
    expect(points[0]).toMatchObject({ linkStatus: 'inferred', minColour: 85, harvestDate: '2026-10-14' })
  })

  it('leaves °C·days out when the temperature record is incomplete', () => {
    const gappy: StudyClimate = { daily: new Map(climate.daily), radiationFinal: new Map(climate.radiationFinal) }
    gappy.daily.set('2026-10-13', { temp: { mean: 20, hours: 10 } })
    gappy.radiationFinal.delete('2026-10-13')
    const [p] = progressionPoints([meas('n1', 's1', '2026-10-12T19:30:00Z', 60)], [{ node: 'n1', harvestDate: '2026-10-14', status: 'confirmed', minColour: null }], gappy, TZ)
    expect([p.toHarvest.days, p.toHarvest.degreeDays, p.toHarvest.radiation]).toEqual([2, null, null])
  })
})

describe('bands, summaries and evaluation', () => {
  it('puts 100% in the top band and summarises by band', () => {
    expect([0, 24.9, 25, 74.9, 75, 100].map(bandOf)).toEqual([0, 0, 1, 2, 3, 3])
    const points = progressionPoints(
      [meas('a', 's1', '2026-10-05T19:00:00Z', 10), meas('b', 's2', '2026-10-09T19:00:00Z', 80)],
      [{ node: 'a', harvestDate: '2026-10-14', status: 'inferred', minColour: 80 }, { node: 'b', harvestDate: '2026-10-12', status: 'inferred', minColour: 80 }],
      climate,
      TZ,
    )
    const s = bandSummaries(points)
    expect(s.map((b) => [b.label, b.fruit, b.days.median])).toEqual([['0–24%', 1, 9], ['25–49%', 0, null], ['50–74%', 0, null], ['75–100%', 1, 3]])
  })

  it('scores on later harvest dates and on held-out stems, only with enough points', () => {
    // 8 stems; on each, fruit photographed at 30% are harvested 6 days later and at 80% 2 days later.
    const ms: ColourMeasurement[] = []
    const hs: DatedHarvest[] = []
    for (let i = 0; i < 16; i++) {
      const day = 1 + i
      const node = `n${i}`
      const pct = i % 2 ? 80 : 30
      ms.push(meas(node, `s${Math.floor(i / 2) % 8}`, `2026-10-${String(day).padStart(2, '0')}T16:00:00Z`, pct))
      hs.push({ node, harvestDate: `2026-10-${String(day + (pct === 80 ? 2 : 6)).padStart(2, '0')}`, status: 'inferred', minColour: 80 })
    }
    const ev = evaluate(progressionPoints(ms, hs, climate, TZ))
    expect(ev.map((e) => e.split)).toEqual(['later_dates', 'held_out_stems'])
    // A perfect band → time relationship: no error, in every measure.
    expect(ev[1].relativeError).toEqual({ days: 0, degreeDays: 0, radiation: 0 })
    expect(evaluate(progressionPoints(ms.slice(0, 4), hs, climate, TZ)).every((e) => Object.values(e.relativeError).every((v) => v === null))).toBe(true)
  })
})
