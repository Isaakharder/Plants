// How much a forecast can be trusted, stated with reasons and stored with
// every locked forecast.
//
//   experimental  the model rests mostly on legacy records (before explicit
//                 stem checks; for Mathieu 2026, records with known
//                 node-identity mistakes), or on very little verified data
//   standard      mostly verified records
//
// Separately, each horizon (week ahead) is low confidence until live locked
// forecasts have validated it (horizonValidation in accuracy.ts); the
// historical backtest is never counted as validation.

export const MIN_VERIFIED_SHARE = 0.5
export const MIN_VERIFIED_EXAMPLES = 500

export function assessConfidence(training: { legacy: number; verified: number }, validatedHorizons: number[], horizon: number) {
  const total = training.legacy + training.verified
  const share = total ? training.verified / total : 0
  const reasons: string[] = []
  if (share < MIN_VERIFIED_SHARE) {
    reasons.push(
      `Experimental: ${Math.round(100 * (1 - share))}% of what the model learned comes from unverified history (records from before explicit stem checks, which may contain node mix-ups).`,
    )
  }
  if (training.verified < MIN_VERIFIED_EXAMPLES) {
    reasons.push(`Only ${training.verified} verified fruit-weeks so far (at least ${MIN_VERIFIED_EXAMPLES} are needed before the model relies on verified data).`)
  }
  const unvalidated = Array.from({ length: horizon }, (_, k) => k + 1).filter((h) => !validatedHorizons.includes(h))
  if (unvalidated.length === horizon) reasons.push('No week ahead has been validated by live forecasts yet; the historical backtest is not validation.')
  else if (unvalidated.length) reasons.push(`Not yet validated by live forecasts: ${unvalidated.map((h) => `+${h}`).join(', ')}.`)
  const level: 'experimental' | 'standard' = share < MIN_VERIFIED_SHARE || training.verified < MIN_VERIFIED_EXAMPLES ? 'experimental' : 'standard'
  return { level, reasons, verifiedShare: share }
}
