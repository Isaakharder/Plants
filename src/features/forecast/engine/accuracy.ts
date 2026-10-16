// Forecast accuracy: fruit counts and kilograms scored separately, so a
// change in fruit weight can't hide a timing error (or the reverse).
//
// Observed harvest of a week = peppers first recorded Harvested in it on the
// forecast's own sampled stems (stems added later don't count). A week whose
// harvest recording is flagged as unreliable (harvests possibly not recorded,
// incomplete visit) is never scored on its own as a zero: it is merged with
// the following week into one block, so harvests logged a week late still
// meet their forecast. A block that would run past the forecast's last week,
// or into a week that can't be scored yet, is left out.

export type ScoringWeek = {
  index: number
  horizon: number
  forecastFruit: number
  observedFruit: number
  forecastKg: number | null
  /** Observed fruit × scale × entered AFW of that week (null without an AFW). */
  observedKg: number | null
}

export type ScoringUnit = {
  /** Horizon of the unit's first week. */
  horizon: number
  weeks: number[]
  block: boolean
  forecastFruit: number
  observedFruit: number
  forecastKg: number | null
  observedKg: number | null
}

/** Groups a forecast's weeks into scoring units (single weeks, or blocks around unreliable weeks). */
export function scoringUnits(weeks: ScoringWeek[], unreliable: Set<number>, lastScoreable: number): ScoringUnit[] {
  const units: ScoringUnit[] = []
  for (let i = 0; i < weeks.length; i++) {
    const group = [weeks[i]]
    while (unreliable.has(group[group.length - 1].index) && i + 1 < weeks.length) group.push(weeks[++i])
    const lastWeek = group[group.length - 1]
    if (unreliable.has(lastWeek.index) || lastWeek.index > lastScoreable) continue
    const sumKg = (key: 'forecastKg' | 'observedKg') => (group.every((w) => w[key] !== null) ? group.reduce((a, w) => a + w[key]!, 0) : null)
    units.push({
      horizon: group[0].horizon,
      weeks: group.map((w) => w.index),
      block: group.length > 1,
      forecastFruit: group.reduce((a, w) => a + w.forecastFruit, 0),
      observedFruit: group.reduce((a, w) => a + w.observedFruit, 0),
      forecastKg: sumKg('forecastKg'),
      observedKg: sumKg('observedKg'),
    })
  }
  return units
}

export type Metrics = {
  n: number
  /** Σ|forecast − observed| ÷ Σ observed. */
  wape: number | null
  /** Mean |forecast − observed|. */
  mae: number | null
  /** Σ forecast ÷ Σ observed − 1 (positive = overprediction). */
  bias: number | null
}

export function metrics(pairs: { forecast: number; observed: number }[]): Metrics {
  if (pairs.length === 0) return { n: 0, wape: null, mae: null, bias: null }
  const absErr = pairs.reduce((a, p) => a + Math.abs(p.forecast - p.observed), 0)
  const obs = pairs.reduce((a, p) => a + p.observed, 0)
  const fc = pairs.reduce((a, p) => a + p.forecast, 0)
  return { n: pairs.length, wape: obs > 0 ? absErr / obs : null, mae: absErr / pairs.length, bias: obs > 0 ? fc / obs - 1 : null }
}

/**
 * Splits a kg error into its fruit-count and fruit-weight parts:
 * log(kg forecast ÷ kg observed) = log(fruit forecast ÷ fruit observed) + log(AFW forecast ÷ AFW observed).
 */
export function kgErrorParts(forecastFruit: number, observedFruit: number, forecastAfw: number, observedAfw: number) {
  return { count: Math.log(forecastFruit / observedFruit), weight: Math.log(forecastAfw / observedAfw) }
}
