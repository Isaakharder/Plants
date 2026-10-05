import { useEffect, useState } from 'react'

// The single source of the collector's "current week". Every week the collector
// shows or saves comes from here, never from a value captured at mount.
//
// Convention (unchanged from CropLink): the greenhouse runs on Toronto time,
// whatever the device's time zone. At 8–11:59 PM on a Sunday in Toronto it is
// already Monday in UTC, but the greenhouse is still in the previous ISO week.

export const GREENHOUSE_TZ = 'America/Toronto'

export type GreenhouseWeek = { year: number; week: number }

export function greenhouseIsoWeek(now: Date = new Date()): GreenhouseWeek {
  const p: Record<string, number> = {}
  for (const x of new Intl.DateTimeFormat('en-US', { timeZone: GREENHOUSE_TZ, year: 'numeric', month: 'numeric', day: 'numeric' }).formatToParts(now)) {
    if (x.type !== 'literal') p[x.type] = Number(x.value)
  }
  const date = new Date(Date.UTC(p.year, p.month - 1, p.day))
  const dayNum = date.getUTCDay() || 7
  date.setUTCDate(date.getUTCDate() + 4 - dayNum)
  const year = date.getUTCFullYear()
  return { year, week: Math.ceil(((date.getTime() - Date.UTC(year, 0, 1)) / 86400000 + 1) / 7) }
}

/** The week to stamp on an observation being saved at this moment. */
export function currentGreenhouseWeek(): GreenhouseWeek {
  return greenhouseIsoWeek(new Date())
}

/** "Sun, Oct 4" in greenhouse time. */
export function greenhouseDayLabel(now: Date = new Date()): string {
  return now.toLocaleDateString(undefined, { timeZone: GREENHOUSE_TZ, weekday: 'short', month: 'short', day: 'numeric' })
}

type WeekDisplay = GreenhouseWeek & { dayLabel: string }

function readDisplay(): WeekDisplay {
  const now = new Date()
  return { ...greenhouseIsoWeek(now), dayLabel: greenhouseDayLabel(now) }
}

/**
 * The current greenhouse week for display. Re-evaluated every minute and when
 * the app returns to the foreground, so a phone left open across Sunday night
 * rolls over to the new week. Saves must still call currentGreenhouseWeek().
 */
export function useGreenhouseWeek(): WeekDisplay {
  const [display, setDisplay] = useState(readDisplay)

  useEffect(() => {
    const refresh = () =>
      setDisplay((prev) => {
        const next = readDisplay()
        return next.year === prev.year && next.week === prev.week && next.dayLabel === prev.dayLabel ? prev : next
      })
    const onVisible = () => {
      if (document.visibilityState === 'visible') refresh()
    }
    const timer = window.setInterval(refresh, 60_000)
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', refresh)
    window.addEventListener('pageshow', refresh)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', refresh)
      window.removeEventListener('pageshow', refresh)
    }
  }, [])

  return display
}
