// Forecast average fruit weight (grams per harvested pepper) for a target
// week.
//
//   Grower AFW  an AFW the grower entered for the target week itself, by the
//               forecast's cutoff (approved 2026-10-15): used as is.
//   Model AFW   otherwise, estimated from the AFWs entered for weeks up to
//               the origin (the actual weights of past harvests).
//
// Backtests turn grower AFW off: the AFW table kept no history before the
// change log, so values typed for those weeks may have been entered later.
//
// Methods:
//   last    the most recent entered week
//   mean3   mean of the last three entered weeks
//   trend6  least-squares line through the last six entered weeks, its slope
//           damped by 0.8 per week ahead (default: in the Mathieu 2026
//           backtest it was the least biased; the 3-week mean ran 5–8% high
//           because fruit weight fell through the season)
//
// Climate later: radiation during a fruit's growth is the main driver of its
// weight, so a regression on light (and fruit load) replaces these smoothers.

import type { AfwMethod, EngineAfw } from './types'
import { weekIndex, weekLabel } from './weeks'

export type AfwChoice = { grams: number; source: string; kind: 'grower' | 'model' }

/** The AFW a forecast uses for a target week: the grower's entry for it, else the model's estimate. */
export function chooseAfw(entries: EngineAfw[], originIndex: number, targetIndex: number, method: AfwMethod, useGrower: boolean): AfwChoice | null {
  if (useGrower) {
    const grower = entries.find((e) => weekIndex(e.year, e.week) === targetIndex && e.afwG > 0)
    if (grower) return { grams: grower.afwG, source: `Grower AFW, entered for ${weekLabel(targetIndex)}`, kind: 'grower' }
  }
  const model = forecastAfw(entries, originIndex, targetIndex, method)
  return model ? { ...model, kind: 'model' } : null
}

/** The model's AFW estimate from the weeks up to the origin. */
export function forecastAfw(entries: EngineAfw[], originIndex: number, targetIndex: number, method: AfwMethod): { grams: number; source: string } | null {
  const known = entries
    .map((e) => ({ index: weekIndex(e.year, e.week), grams: e.afwG }))
    .filter((e) => e.index <= originIndex && e.grams > 0)
    .sort((a, b) => a.index - b.index)
  if (known.length === 0) return null
  const span = (list: typeof known) => (list.length === 1 ? weekLabel(list[0].index) : `${weekLabel(list[0].index)}–${weekLabel(list[list.length - 1].index)}`)

  if (method === 'last' || known.length === 1) {
    const e = known[known.length - 1]
    return { grams: e.grams, source: `Entered AFW, ${weekLabel(e.index)}` }
  }
  if (method === 'mean3') {
    const last = known.slice(-3)
    return { grams: last.reduce((a, e) => a + e.grams, 0) / last.length, source: `Mean of entered AFW, ${span(last)}` }
  }
  const last = known.slice(-6)
  const n = last.length
  const mx = last.reduce((a, e) => a + e.index, 0) / n
  const my = last.reduce((a, e) => a + e.grams, 0) / n
  const sxx = last.reduce((a, e) => a + (e.index - mx) ** 2, 0)
  const slope = sxx === 0 ? 0 : last.reduce((a, e) => a + (e.index - mx) * (e.grams - my), 0) / sxx
  const level = my + slope * (originIndex - mx)
  let damped = 0
  for (let k = 1; k <= targetIndex - originIndex; k++) damped += 0.8 ** k
  return { grams: Math.max(level + slope * damped, 1), source: `Damped trend of entered AFW, ${span(last)}` }
}
