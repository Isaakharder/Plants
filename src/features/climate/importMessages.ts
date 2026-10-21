// Plain-language explanations of climate import results and file issues, for
// the import dialog and the file details (short enough to read on a phone).

/** The stored file an upload was matched with. */
export type MatchedFile = {
  file_id: string
  filename: string
  received_at: string
  hour_local: string | null
  file_status: string
  channel: string
}

export type ImportOutcome = {
  status: 'created' | 'duplicate' | 'conflict' | 'quarantined' | 'error'
  reason?: string | null
  matched?: MatchedFile | null
  hour_local?: string | null
  readings?: number | null
  problems?: string[]
  warnings?: string[]
  message?: string
}

const hour = (h: string | null | undefined) => (h ? h.slice(0, 16) : 'an unknown hour')
const when = (iso: string) =>
  new Date(iso).toLocaleString('en-CA', { timeZone: 'America/Toronto', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })
const stored = (m: MatchedFile) => `“${m.filename}”, imported ${when(m.received_at)}`

/** Problems and warnings, by code, in plain words. Unknown codes are shown as they are. */
export const ISSUE_TEXT: Record<string, string> = {
  system_time_mismatch: 'The time inside the file doesn’t match the time in its name; it may be a renamed copy of another hour.',
  same_readings_as_other_hour: 'Every reading is identical to another hour’s file; it is probably a copy with the wrong hour.',
  filename_time_off_hour: 'The time in the file name isn’t close to a whole hour.',
  system_time_off_hour: 'The time inside the file isn’t close to a whole hour.',
  ambiguous_system_date: 'The date inside the file could be month-first or day-first.',
  no_timestamp: 'Neither the file name nor the file says which hour it is.',
  nonexistent_local_time: 'That hour doesn’t exist (clocks went forward).',
  repeated_hour_ambiguous: 'That hour happens twice (clocks went back) and needs a decision.',
  no_readings: 'The file has no readings.',
  no_system_time: 'The file has no System time to check its hour against.',
  time_from_system_clock: 'The file name has no time; the hour comes from inside the file.',
  week_number_mismatch: 'The week number inside the file doesn’t match its date.',
  repeated_hour_resolved: 'An hour that happens twice (clocks went back) was placed by when the file arrived.',
  unreadable_system_date: 'The date inside the file can’t be read.',
}

export const issueText = (code: string) => ISSUE_TEXT[code] ?? code

/** One sentence saying what happened to an uploaded file. */
export function importMessage(r: ImportOutcome): string {
  const m = r.matched ?? null
  switch (r.status) {
    case 'created':
      return `Imported for ${hour(r.hour_local)}${r.readings != null ? ` (${r.readings} readings)` : ''}.`
    case 'duplicate':
      if (r.reason === 'same_readings' && m) return `Already imported: the same readings for ${hour(m.hour_local)} are in ${stored(m)}. Nothing new was added.`
      if (m) return `Already imported: this exact file is ${stored(m)} (${hour(m.hour_local)}). Nothing new was added.`
      return `Already imported (${hour(r.hour_local)}). Nothing new was added.`
    case 'conflict':
      return m
        ? `${hour(r.hour_local)} already has a different file (${stored(m)}). This one is kept for an owner to review; the first stays in use.`
        : `${hour(r.hour_local)} already has a different file. This one is kept for an owner to review; the first stays in use.`
    case 'quarantined':
      if (r.reason === 'same_readings_as_other_hour' && m)
        return `Held for review: every reading is identical to the ${hour(m.hour_local)} file (${stored(m)}). It is not used until an owner checks it.`
      return `Held for review: ${(r.problems ?? []).map(issueText).join(' ') || 'its hour couldn’t be decided.'} It is not used until an owner checks it.`
    case 'error':
      return r.message ?? 'Not stored; try this file again.'
  }
}

/** A one-line summary of a batch: "12 imported · 3 already imported · 1 held for review". */
export function importSummary(results: readonly ImportOutcome[]): string {
  const n = (s: ImportOutcome['status']) => results.filter((r) => r.status === s).length
  const parts: [number, string][] = [
    [n('created'), 'imported'],
    [n('duplicate'), 'already imported'],
    [n('conflict') + n('quarantined'), 'held for review'],
    [n('error'), 'not stored'],
  ]
  return parts.filter(([c]) => c > 0).map(([c, t]) => `${c} ${t}`).join(' · ')
}
