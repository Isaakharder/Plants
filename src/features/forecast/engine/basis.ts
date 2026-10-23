// The forecast basis in effect for a variety and week (forecast_basis_settings).
//
// Settings are append-only: each row says "from this week on, the basis is …".
// In effect at a week: the row with the latest start week at or before it,
// among rows stored by the cutoff (ties: the newest row). With no row, the
// caller's default applies.
//
// The harvest-ready share (Ready %) is chosen per sampling week and does not
// carry forward (approved 2026-10-23): only a Breakers-only row whose start
// week is that very week sets it (the newest one stored by the cutoff);
// otherwise harvestReadyShare is null and the caller's default (100%) applies.
// The basis itself still carries forward.

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
  if (!best) return { basis: fallback, harvestReadyShare: fallback === 'breaker_only' ? shareChosenFor(settings, index, cutoffMs) : null, source: { kind: 'default' } }
  return {
    basis: best.basis,
    harvestReadyShare: best.basis === 'breaker_only' ? shareChosenFor(settings, index, cutoffMs) : null,
    source: { kind: 'setting', fromYear: best.fromYear, fromWeek: best.fromWeek },
  }
}

/** The Ready % chosen for exactly this sampling week (newest Breakers-only entry starting that week, stored by the cutoff), or null. */
export function shareChosenFor(settings: EngineBasisSetting[] | undefined, index: number, cutoffMs: number): number | null {
  let chosen: EngineBasisSetting | null = null
  for (const s of settings ?? []) {
    if (s.basis !== 'breaker_only' || s.harvestReadyShare === null || Date.parse(s.createdAt) > cutoffMs || weekIndex(s.fromYear, s.fromWeek) !== index) continue
    if (!chosen || s.createdAt > chosen.createdAt) chosen = s
  }
  return chosen?.harvestReadyShare ?? null
}
