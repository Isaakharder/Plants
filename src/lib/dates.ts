// Crop dates are calendar dates ("YYYY-MM-DD") with no time zone.
// Never pass them through `new Date(string)`, which parses as UTC and can
// shift the day backwards in North American time zones.

export type IsoDate = string

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/

function toLocalDate(iso: IsoDate): Date {
  const [, y, m, d] = ISO_DATE.exec(iso) ?? []
  return new Date(Number(y), Number(m) - 1, Number(d))
}

export function isIsoDate(value: string): boolean {
  const match = ISO_DATE.exec(value)
  if (!match) return false
  const date = toLocalDate(value)
  return date.getFullYear() === Number(match[1]) && date.getMonth() === Number(match[2]) - 1 && date.getDate() === Number(match[3])
}

export function todayIso(): IsoDate {
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

/** "Dec 8, 2025" */
export function formatDate(iso: IsoDate): string {
  return toLocalDate(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

/** "December 8, 2025" */
export function formatDateLong(iso: IsoDate): string {
  return toLocalDate(iso).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
}

/** Whole days from a to b (b - a). */
export function daysBetween(a: IsoDate, b: IsoDate): number {
  return Math.round((toLocalDate(b).getTime() - toLocalDate(a).getTime()) / 86_400_000)
}
