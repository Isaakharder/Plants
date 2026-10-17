// One imported file: where it came from, how its hour was decided, its
// readings exactly as received, how it differs from the file in use for the
// same hour, its review history, and (owners) review decisions. The original
// file and its readings never change; a decision only changes which file is
// used for the hour, and is recorded with a note.

import { useState } from 'react'
import { Dialog } from '../../components/Dialog'
import { ErrorState, LoadingState } from '../../components/States'
import type { ClimateReadingRow } from '../../lib/database.types'
import { localToUtcCandidates } from '../../../supabase/functions/_shared/climate/zonedTime.ts'
import { downloadOriginal, useClimateZones, useFileDetail, useResolveQuarantine, useReviewFile, type FileDetail } from './api'
import { StateBadge } from './StateBadge'
import { GREENHOUSE_TIME_ZONE, sortZones, zoneName } from './model'
import styles from './Climate.module.css'

const ACTION_LABEL: Record<string, string> = {
  activate: 'Put into use',
  set_aside: 'Set aside',
  resolve_quarantine: 'Hour assigned (quarantine resolved)',
  superseded_by_review: 'Replaced by another file',
}

const TIME_METHOD: Record<string, string> = { filename: 'from the filename', system: 'from the System date/time', review: 'assigned at review' }

export function FileDialog({ fileId, onClose, canReview }: { fileId: string | null; onClose: () => void; canReview: boolean }) {
  const detail = useFileDetail(fileId)
  return (
    <Dialog open={Boolean(fileId)} title={detail.data?.file.original_filename ?? 'Imported file'} onClose={onClose} className={styles.wideDialog}>
      {detail.error ? <ErrorState error={detail.error} /> : detail.isPending ? <LoadingState /> : <Detail d={detail.data} canReview={canReview} />}
    </Dialog>
  )
}

function Detail({ d, canReview }: { d: FileDetail; canReview: boolean }) {
  const f = d.file
  const zones = useClimateZones(f.source_id)
  const zoneLabel = (id: string) => {
    const z = zones.data?.find((x) => x.id === id)
    return z ? zoneName(z) : '?'
  }
  const [downloading, setDownloading] = useState(false)

  const download = async () => {
    setDownloading(true)
    try {
      const { name, bytes } = await downloadOriginal(f.id)
      const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'text/csv' }))
      const a = document.createElement('a')
      a.href = url
      a.download = name
      a.click()
      URL.revokeObjectURL(url)
    } finally {
      setDownloading(false)
    }
  }

  return (
    <div className={styles.form}>
      <div className={styles.sectionHead}>
        <StateBadge state={f.hour_state} />
        <button type="button" className="button button-secondary" onClick={download} disabled={downloading}>
          {downloading ? 'Preparing…' : 'Download original'}
        </button>
      </div>
      <dl className={styles.dl}>
        <dt>Hour</dt>
        <dd>{f.hour_local ? `${f.hour_local.slice(0, 16)} (${TIME_METHOD[f.time_method ?? ''] ?? ''})` : 'Not decided (quarantined)'}</dd>
        <dt>Filename time</dt>
        <dd>{f.filename_local ?? 'none'}</dd>
        <dt>System date / time</dt>
        <dd>
          {f.system_date_raw ?? '—'} · {f.system_time_raw ?? '—'}
          {f.date_order && <span className={styles.muted}> (read as {f.date_order === 'MDY' ? 'month-first' : f.date_order === 'DMY' ? 'day-first' : 'either order'})</span>}
          {f.clock_offset_minutes !== null && Number(f.clock_offset_minutes) !== 0 && <span className={styles.muted}> · clock {Number(f.clock_offset_minutes) > 0 ? '+' : ''}{Number(f.clock_offset_minutes)} min</span>}
        </dd>
        <dt>Received</dt>
        <dd>
          {new Date(f.received_at).toLocaleString()} · {f.channel === 'agent' ? `agent${f.agent_version ? ` ${f.agent_version}` : ''}` : 'manual upload'}
        </dd>
        <dt>Original</dt>
        <dd>
          {f.byte_size} bytes · {f.encoding} · <span className={styles.mono}>SHA-256 {f.sha256.slice(0, 16)}…</span>
        </dd>
        <dt>Parser</dt>
        <dd>{f.parser_version}</dd>
        {f.review_note && (
          <>
            <dt>Last review</dt>
            <dd>
              {f.review_note} <span className={styles.muted}>({f.reviewed_at ? new Date(f.reviewed_at).toLocaleString() : ''})</span>
            </dd>
          </>
        )}
      </dl>

      {(f.problems.length > 0 || f.warnings.length > 0) && (
        <ul className={styles.warnings}>
          {f.problems.map((p) => (
            <li key={`p${p.code}`} className={styles.warning}>
              ⛔ <span>{p.message}</span>
            </li>
          ))}
          {f.warnings.map((p) => (
            <li key={`w${p.code}`} className={`${styles.warning} ${styles.info}`}>
              ⚠ <span>{p.message}</span>
            </li>
          ))}
        </ul>
      )}

      {canReview && <ReviewActions d={d} />}

      {d.active && <Differences mine={d.readings} active={d.active.readings} activeName={d.active.file.original_filename} zoneLabel={zoneLabel} />}

      {d.readings.length > 0 && <ReadingsTable readings={d.readings} zoneOrder={sortZones(zones.data ?? []).map((z) => z.id)} zoneLabel={zoneLabel} />}

      {d.reviews.length > 0 && (
        <div>
          <h3 className={styles.chartTitle}>Review history</h3>
          <ul className={styles.warnings}>
            {d.reviews.map((r) => (
              <li key={r.id} className={`${styles.warning} ${styles.info}`}>
                <span>
                  <strong>{ACTION_LABEL[r.action]}</strong> · {r.state_before} → {r.state_after} · {new Date(r.reviewed_at).toLocaleString()} — {r.note}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

function ReviewActions({ d }: { d: FileDetail }) {
  const f = d.file
  const review = useReviewFile()
  const resolve = useResolveQuarantine()
  const [note, setNote] = useState('')
  const [date, setDate] = useState(f.filename_local?.slice(0, 10) ?? '')
  const [hour, setHour] = useState(f.filename_local ? String(Math.round(Number(f.filename_local.slice(11, 13)) + Number(f.filename_local.slice(14, 16)) / 60) % 24) : '0')
  const [candidate, setCandidate] = useState(0)
  const busy = review.isPending || resolve.isPending
  const error = review.error ?? resolve.error

  if (f.hour_state === 'active') return null

  const noteField = (
    <label className="field">
      <span className="field-label">Why (recorded with the decision)</span>
      <input className="input" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Re-exported after the clock was corrected" />
    </label>
  )

  if (f.hour_state === 'none') {
    const [y, m, dd] = date.split('-').map(Number)
    const candidates = date ? localToUtcCandidates({ year: y, month: m, day: dd, hour: Number(hour), minute: 0, second: 0 }, GREENHOUSE_TIME_ZONE) : []
    const chosen = candidates[Math.min(candidate, candidates.length - 1)]
    return (
      <div className={styles.card}>
        <h3 className={styles.chartTitle}>Assign the hour</h3>
        <p className={`${styles.small} ${styles.muted}`}>
          The file is re-read from its stored original with this hour (greenhouse time). If the file can’t be read at all, it stays quarantined.
        </p>
        <div className={styles.controls}>
          <label className="field">
            <span className="field-label">Date</span>
            <input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </label>
          <label className="field">
            <span className="field-label">Hour</span>
            <select className="input" value={hour} onChange={(e) => setHour(e.target.value)}>
              {Array.from({ length: 24 }, (_, h) => (
                <option key={h} value={h}>
                  {String(h).padStart(2, '0')}:00
                </option>
              ))}
            </select>
          </label>
          {candidates.length === 2 && (
            <label className="field">
              <span className="field-label">This hour happens twice</span>
              <select className="input" value={candidate} onChange={(e) => setCandidate(Number(e.target.value))}>
                <option value={0}>First (daylight time, EDT)</option>
                <option value={1}>Second (standard time, EST)</option>
              </select>
            </label>
          )}
        </div>
        {date && candidates.length === 0 && <p className={styles.partial}>That time doesn’t exist (the clocks went forward).</p>}
        {noteField}
        {error && <p className="field-error">{error.message}</p>}
        <div className={styles.actions}>
          <button
            type="button"
            className="button button-primary"
            disabled={busy || !note.trim() || chosen === undefined}
            onClick={() => resolve.mutate({ fileId: f.id, hourUtc: new Date(chosen).toISOString(), note: note.trim() })}
          >
            {resolve.isPending ? 'Saving…' : 'Assign hour and import readings'}
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className={styles.card}>
      <h3 className={styles.chartTitle}>{f.hour_state === 'conflict' ? 'Another file is in use for this hour' : 'This file is not in use'}</h3>
      <p className={`${styles.small} ${styles.muted}`}>Both files and their readings are kept. Your choice only decides which one is used for the hour, and is recorded.</p>
      {noteField}
      {error && <p className="field-error">{error.message}</p>}
      <div className={styles.actions}>
        {f.hour_state === 'conflict' && (
          <button type="button" className="button button-secondary" disabled={busy || !note.trim()} onClick={() => review.mutate({ fileId: f.id, action: 'set_aside', note: note.trim() })}>
            Keep the current file
          </button>
        )}
        <button type="button" className="button button-primary" disabled={busy || !note.trim()} onClick={() => review.mutate({ fileId: f.id, action: 'activate', note: note.trim() })}>
          Use this file for the hour
        </button>
      </div>
    </div>
  )
}

function Differences({ mine, active, activeName, zoneLabel }: { mine: ClimateReadingRow[]; active: ClimateReadingRow[]; activeName: string; zoneLabel: (id: string) => string }) {
  const key = (r: ClimateReadingRow) => `${r.zone_id}|${r.row_label}`
  const theirs = new Map(active.map((r) => [key(r), r]))
  const ours = new Map(mine.map((r) => [key(r), r]))
  const keys = [...new Set([...ours.keys(), ...theirs.keys()])]
  const diffs = keys.filter((k) => ours.get(k)?.raw_text !== theirs.get(k)?.raw_text)
  return (
    <div>
      <h3 className={styles.chartTitle}>Compared with the file in use ({activeName})</h3>
      {diffs.length === 0 ? (
        <p className={`${styles.small} ${styles.muted}`}>Same values in every cell.</p>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Zone</th>
                <th className={styles.left}>Row</th>
                <th>This file</th>
                <th>In use</th>
              </tr>
            </thead>
            <tbody>
              {diffs.slice(0, 200).map((k) => {
                const [zone, row] = k.split('|')
                return (
                  <tr key={k}>
                    <td>{zoneLabel(zone)}</td>
                    <td className={styles.left}>{row}</td>
                    <td className={styles.diff}>{ours.get(k)?.raw_text ?? '—'}</td>
                    <td>{theirs.get(k)?.raw_text ?? '—'}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          {diffs.length > 200 && <p className={styles.muted}>…and {diffs.length - 200} more.</p>}
        </div>
      )}
    </div>
  )
}

function ReadingsTable({ readings, zoneOrder, zoneLabel }: { readings: ClimateReadingRow[]; zoneOrder: string[]; zoneLabel: (id: string) => string }) {
  const rows = [...new Set(readings.map((r) => r.row_label))]
  const zoneIds = zoneOrder.filter((id) => readings.some((r) => r.zone_id === id))
  const cell = new Map(readings.map((r) => [`${r.zone_id}|${r.row_label}`, r]))
  return (
    <details>
      <summary className={styles.small}>Readings as received ({readings.length})</summary>
      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Row</th>
              {zoneIds.map((z) => (
                <th key={z}>{zoneLabel(z)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row}>
                <td>{row}</td>
                {zoneIds.map((z) => {
                  const r = cell.get(`${z}|${row}`)
                  return (
                    <td key={z} className={r && r.flags.length > 0 ? styles.flagged : undefined} title={r?.flags.join(', ') || undefined}>
                      {r?.raw_text ?? ''}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  )
}
