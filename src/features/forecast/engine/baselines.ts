// Simple forecasting methods the stage model must beat, all on the same
// as-of history and the same sampled stems.
//
//   lastWeek      every week ahead = the harvests recorded in the origin week
//   mean3         every week ahead = mean of the last three weeks' harvests
//   cohortLadder  the existing +N percentages: each set cohort's sets × the
//                 share of earlier cohorts first harvested at that age (what
//                 the Weekly Plant Data ladder shows), ignoring each fruit's
//                 current stage

import type { CropHistory } from './history'

export type BaselineId = 'lastWeek' | 'mean3' | 'cohortLadder'

const harvestsIn = (history: CropHistory, index: number) => history.nodes.filter((h) => h.harvestIndex === index).length

export function baselineForecast(history: CropHistory, id: BaselineId, horizon = 5): number[] {
  const o = history.originIndex
  if (id === 'lastWeek') return new Array(horizon).fill(harvestsIn(history, o))
  if (id === 'mean3') {
    const m = (harvestsIn(history, o) + harvestsIn(history, o - 1) + harvestsIn(history, o - 2)) / 3
    return new Array(horizon).fill(m)
  }
  // Cohort ladder: share of a cohort first harvested at exactly age a (cohorts old enough to have reached a).
  const maxAge = 12
  const cohorts = new Map<number, number>()
  for (const h of history.nodes) if (h.fruitIndex !== null) cohorts.set(h.fruitIndex, (cohorts.get(h.fruitIndex) ?? 0) + 1)
  const share: number[] = []
  for (let a = 0; a <= maxAge; a++) {
    let sets = 0
    let harvested = 0
    for (const [c, n] of cohorts) {
      if (c + a > o) continue
      sets += n
      harvested += history.nodes.filter((h) => h.fruitIndex === c && h.harvestIndex === c + a).length
    }
    share.push(sets > 0 ? harvested / sets : 0)
  }
  return Array.from({ length: horizon }, (_, k) => {
    let expected = 0
    for (const [c, n] of cohorts) {
      const age = o + k + 1 - c
      if (age >= 1 && age <= maxAge) expected += n * share[age]
    }
    return expected
  })
}
