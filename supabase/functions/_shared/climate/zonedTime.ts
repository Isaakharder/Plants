// Wall-clock time in a named time zone (the climate computer's, America/Toronto)
// ↔ UTC, without a date library. Plain TypeScript: used by the Edge Function
// (Deno) and by the tests (Node).

export type LocalDateTime = { year: number; month: number; day: number; hour: number; minute: number; second: number }

const formatters = new Map<string, Intl.DateTimeFormat>()

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
    formatters.set(timeZone, f)
  }
  return f
}

/** The wall-clock time in `timeZone` at a UTC instant. */
export function wallClock(utcMs: number, timeZone: string): LocalDateTime {
  const parts = Object.fromEntries(formatter(timeZone).formatToParts(new Date(utcMs)).map((p) => [p.type, p.value]))
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    second: Number(parts.second),
  }
}

const sameWall = (a: LocalDateTime, b: LocalDateTime) =>
  a.year === b.year && a.month === b.month && a.day === b.day && a.hour === b.hour && a.minute === b.minute && a.second === b.second

/**
 * Every UTC instant whose wall-clock time in `timeZone` is `local`, ascending:
 * none in the spring-forward gap, two in the repeated autumn hour, otherwise one.
 */
export function localToUtcCandidates(local: LocalDateTime, timeZone: string): number[] {
  const asUtc = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second)
  const out = new Set<number>()
  // Any real offset lies within ±14 h; checking each quarter hour covers every zone.
  for (let offsetQ = -56; offsetQ <= 56; offsetQ++) {
    const t = asUtc - offsetQ * 15 * 60_000
    if (sameWall(wallClock(t, timeZone), local)) out.add(t)
  }
  return [...out].sort((a, b) => a - b)
}

export function isValidDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1 || year < 2000 || year > 2100) return false
  const d = new Date(Date.UTC(year, month - 1, day))
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day
}

/** Minutes between two wall-clock times, as if no clock change happened between them. */
export function wallMinutes(a: LocalDateTime): number {
  return Date.UTC(a.year, a.month - 1, a.day, a.hour, a.minute, a.second) / 60_000
}

export function fromWallMinutes(minutes: number): LocalDateTime {
  const d = new Date(minutes * 60_000)
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    second: d.getUTCSeconds(),
  }
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0')

export function formatLocal(t: LocalDateTime): string {
  return `${t.year}-${pad(t.month)}-${pad(t.day)} ${pad(t.hour)}:${pad(t.minute)}:${pad(t.second)}`
}

/** ISO 8601 week number of a calendar date. */
export function isoWeek(year: number, month: number, day: number): number {
  const d = new Date(Date.UTC(year, month - 1, day))
  const dow = d.getUTCDay() || 7
  d.setUTCDate(d.getUTCDate() + 4 - dow)
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1)
  return Math.ceil(((d.getTime() - yearStart) / 86_400_000 + 1) / 7)
}
