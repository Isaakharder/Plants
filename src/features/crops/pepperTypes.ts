// Pepper type assumptions as people type and read them. Timing is written as
// "weeks after set: share %", e.g. "5:20, 6:30, 7:30, 8:20" (must add up to
// 100%); stored as shares by age 0 … 10 (pepper_types.provisional_timing).

export const TIMING_AGES = 11

/** "5:20, 6:30, 7:30, 8:20" from shares by age (empty: not configured). */
export function formatTiming(shares: number[] | null): string {
  if (!shares) return ''
  return shares
    .map((share, age) => [age, share] as const)
    .filter(([, share]) => share > 0)
    .map(([age, share]) => `${age}:${Math.round(share * 1000) / 10}`)
    .join(', ')
}

/** Shares by age from "5:20, 6:30, …"; '' is null (not configured). */
export function parseTiming(text: string): { shares: number[] | null } | { error: string } {
  const trimmed = text.trim()
  if (trimmed === '') return { shares: null }
  const shares = Array<number>(TIMING_AGES).fill(0)
  for (const part of trimmed.split(',')) {
    const m = part.trim().match(/^(\d{1,2})\s*:\s*(\d+(?:[.,]\d+)?)\s*%?$/)
    if (!m) return { error: `“${part.trim()}” isn’t “weeks:percent”` }
    const age = Number(m[1])
    const percent = Number(m[2].replace(',', '.'))
    if (age >= TIMING_AGES) return { error: `Weeks after set go up to ${TIMING_AGES - 1}` }
    if (shares[age] > 0) return { error: `Week ${age} appears twice` }
    shares[age] = percent / 100
  }
  const total = shares.reduce((s, v) => s + v, 0)
  if (Math.abs(total - 1) > 0.001) return { error: `The shares add up to ${Math.round(total * 1000) / 10}%, not 100%` }
  return { shares: shares.map((v) => Math.round(v * 10000) / 10000) }
}

/** A percentage 1–100 (e.g. survival), '' is null. */
export function parsePercent(text: string): { value: number | null } | { error: string } {
  const trimmed = text.trim().replace(',', '.')
  if (trimmed === '') return { value: null }
  const n = Number(trimmed)
  if (!Number.isFinite(n) || n <= 0 || n > 100) return { error: 'Enter a percentage above 0, up to 100' }
  return { value: Math.round(n * 10) / 1000 }
}

/** AFW in grams (0.1–2000), '' is null. */
export function parseAfwGrams(text: string): { value: number | null } | { error: string } {
  const trimmed = text.trim().replace(',', '.')
  if (trimmed === '') return { value: null }
  const n = Number(trimmed)
  if (!Number.isFinite(n) || n <= 0 || n > 2000) return { error: 'Enter grams per pepper (up to 2000)' }
  return { value: Math.round(n * 10) / 10 }
}
