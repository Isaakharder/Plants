// The forecast basis in effect for a variety and week (forecast_basis_settings).
//
// Settings are append-only: each row says "from this week on, the basis is …".
// In effect at a week: the row with the latest start week at or before it,
// among rows stored by the cutoff (ties: the newest row). With no row, the
// caller's default applies.

import type { EngineBasisSetting, ForecastBasis } from './types'
import { weekIndex } from './weeks'

export type BasisInEffect = {
  basis: ForecastBasis
  harvestReadyShare: number | null
  source: { kind: 'setting'; fromYear: number; fromWeek: number } | { kind: 'default' }
}

export function basisAt(settings: EngineBasisSetting[] | undefined, index: number, cutoffMs: number, fallback: ForecastBasis = 'lifecycle'): BasisInEffect {
  let best: EngineBasisSetting | null = null
  for (const s of settings ?? []) {
    if (Date.parse(s.createdAt) > cutoffMs || weekIndex(s.fromYear, s.fromWeek) > index) continue
    if (
      !best ||
      weekIndex(s.fromYear, s.fromWeek) > weekIndex(best.fromYear, best.fromWeek) ||
      (weekIndex(s.fromYear, s.fromWeek) === weekIndex(best.fromYear, best.fromWeek) && s.createdAt > best.createdAt)
    ) {
      best = s
    }
  }
  if (!best) return { basis: fallback, harvestReadyShare: null, source: { kind: 'default' } }
  return {
    basis: best.basis,
    harvestReadyShare: best.basis === 'breaker_only' ? best.harvestReadyShare : null,
    source: { kind: 'setting', fromYear: best.fromYear, fromWeek: best.fromWeek },
  }
}
