// Climate › Imports: health at a glance, missing hours, every received file,
// the upload log (including duplicates), manual imports and review.

import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { EmptyState, ErrorState, LoadingState } from '../../components/States'
import type { ClimateImportStatus } from '../../lib/database.types'
import { useOrganization } from '../organization/OrganizationProvider'
import { PAGE, useClimateSource, useImportAttempts, useImportFiles, useImportStatus, useMissingHours, type ClimateFile, type FileFilter } from './api'
import { ClimateTabs } from './ClimateTabs'
import { FileDialog } from './FileDialog'
import { ManualImportDialog } from './ManualImportDialog'
import { importMessage, type MatchedFile } from './importMessages'
import { StateBadge } from './StateBadge'
import { useNow } from './useNow'
import { formatLocalHour, missingWarning } from './model'
import styles from './Climate.module.css'

const ago = (iso: string | null | undefined, now: number) => {
  if (!iso) return '—'
  const min = Math.round((now - Date.parse(iso)) / 60000)
  if (min < 2) return 'just now'
  if (min < 90) return `${min} min ago`
  const h = Math.round(min / 60)
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`
}

const localTime = (iso: string) => formatLocalHour(Math.floor(Date.parse(iso) / 1000))

export function ClimateImports() {
  const organization = useOrganization()
  const source = useClimateSource(organization.id)
  const status = useImportStatus(source.data?.id)
  const [params, setParams] = useSearchParams()
  const filter = (params.get('filter') ?? 'all') as FileFilter
  const [limit, setLimit] = useState(PAGE)
  const [openFile, setOpenFile] = useState<string | null>(params.get('file'))
  const [importing, setImporting] = useState(false)
  const [view, setView] = useState<'files' | 'log'>('files')

  const now = useNow()
  const nowH = Math.floor(now / 3_600_000) * 3_600_000
  const from30 = new Date(nowH - 30 * 24 * 3_600_000).toISOString()
  const firstHour = status.data?.first_hour
  const missingFrom = firstHour && firstHour > from30 ? firstHour : from30
  const missing = useMissingHours(source.data?.id, missingFrom, new Date(nowH).toISOString())
  const files = useImportFiles(source.data?.id, filter, limit)
  const attempts = useImportAttempts(view === 'log' ? source.data?.id : undefined)

  const frame = (body: React.ReactNode) => (
    <section className={styles.section} aria-label="Climate imports">
      <div className={styles.toolbar}>
        <ClimateTabs reviewCount={status.data?.to_review ?? 0} />
      </div>
      {body}
    </section>
  )
  if (source.isPending) return frame(<LoadingState />)
  if (source.error) return frame(<ErrorState error={source.error} />)
  if (!source.data) return frame(<EmptyState title="Climate data isn’t set up yet" description="An owner can set it up in Settings › Climate." />)

  const owner = organization.role === 'owner'
  const gapWarning = firstHour ? missingWarning(missing.data ?? []) : null

  return frame(
    <>
      <StatusCards status={status.data ?? null} now={now} />
      {gapWarning && (
        <ul className={styles.warnings}>
          <li className={styles.warning}>
            ⚠ <span>Last 30 days: {gapWarning.text}</span>
          </li>
        </ul>
      )}

      <div className={styles.card}>
        <div className={styles.sectionHead}>
          <div className={styles.controls}>
            <div className={styles.segmented} role="group" aria-label="Show">
              <button type="button" aria-pressed={view === 'files'} onClick={() => setView('files')}>
                Files
              </button>
              <button type="button" aria-pressed={view === 'log'} onClick={() => setView('log')}>
                Upload log
              </button>
            </div>
            {view === 'files' && (
              <select
                className={`input ${styles.compactSelect}`}
                value={filter}
                aria-label="Filter"
                onChange={(e) => {
                  setLimit(PAGE)
                  setParams((p) => {
                    const n = new URLSearchParams(p)
                    if (e.target.value === 'all') n.delete('filter')
                    else n.set('filter', e.target.value)
                    return n
                  })
                }}
              >
                <option value="all">All files</option>
                <option value="review">To review ({status.data?.to_review ?? 0})</option>
                <option value="active">In use</option>
                <option value="conflict">Conflicts</option>
                <option value="none">Quarantined</option>
                <option value="superseded">Not used</option>
              </select>
            )}
          </div>
          {owner && (
            <button type="button" className="button button-primary" onClick={() => setImporting(true)}>
              Import CSV files…
            </button>
          )}
        </div>

        {view === 'files' ? (
          files.error ? (
            <ErrorState error={files.error} />
          ) : files.isPending ? (
            <LoadingState />
          ) : files.data.length === 0 ? (
            <p className={styles.empty}>No files{filter !== 'all' ? ' in this view' : ' yet'}.</p>
          ) : (
            <>
              <div className={styles.tableWrap}>
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th>Hour</th>
                      <th className={styles.left}>File</th>
                      <th className={styles.left}>Status</th>
                      <th className={styles.hideNarrow}>Received</th>
                      <th className={styles.hideNarrow}>Via</th>
                    </tr>
                  </thead>
                  <tbody>
                    {files.data.map((f) => (
                      <FileRow key={f.id} f={f} onOpen={() => setOpenFile(f.id)} />
                    ))}
                  </tbody>
                </table>
              </div>
              {files.data.length >= limit && (
                <div className={styles.actions}>
                  <button type="button" className="button button-secondary" onClick={() => setLimit((l) => l + PAGE)}>
                    Show more
                  </button>
                </div>
              )}
            </>
          )
        ) : attempts.error ? (
          <ErrorState error={attempts.error} />
        ) : attempts.isPending ? (
          <LoadingState />
        ) : (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Received</th>
                  <th className={styles.left}>File</th>
                  <th className={styles.left}>Outcome</th>
                  <th className={styles.hideNarrow}>Via</th>
                </tr>
              </thead>
              <tbody>
                {attempts.data.map((a) => (
                  <tr key={a.id} className={a.file_id ? styles.rowButton : undefined} onClick={() => a.file_id && setOpenFile(a.file_id)}>
                    <td>{new Date(a.created_at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</td>
                    <td className={`${styles.left} ${styles.wrap}`}>
                      {a.filename}
                      {a.outcome !== 'created' && (
                        <div className={`${styles.small} ${styles.muted}`}>
                          {importMessage({ status: a.outcome, reason: a.detail.reason as string | undefined, matched: a.detail.matched as MatchedFile | undefined })}
                        </div>
                      )}
                    </td>
                    <td className={styles.left}>
                      <StateBadge state={a.outcome} />
                    </td>
                    <td className={styles.hideNarrow}>{a.channel === 'agent' ? 'Agent' : 'Manual'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {attempts.data.length === 0 && <p className={styles.empty}>No uploads yet.</p>}
          </div>
        )}
      </div>

      <FileDialog fileId={openFile} onClose={() => setOpenFile(null)} canReview={owner} />
      {owner && <ManualImportDialog open={importing} sourceId={source.data.id} onClose={() => setImporting(false)} />}
    </>,
  )
}

function FileRow({ f, onOpen }: { f: ClimateFile; onOpen: () => void }) {
  const issues = f.problems.length + f.warnings.length
  return (
    <tr className={styles.rowButton} onClick={onOpen} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && onOpen()}>
      <td>{f.hour_local ? f.hour_local.slice(0, 16) : <span className={styles.muted}>no hour</span>}</td>
      <td className={`${styles.left} ${styles.wrap}`}>
        {f.original_filename}
        {issues > 0 && <span className={`${styles.small} ${styles.partial}`}> · ⚠ {issues}</span>}
      </td>
      <td className={styles.left}>
        <StateBadge state={f.hour_state} />
      </td>
      <td className={styles.hideNarrow}>{new Date(f.received_at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</td>
      <td className={styles.hideNarrow}>{f.channel === 'agent' ? 'Agent' : 'Manual'}</td>
    </tr>
  )
}

function StatusCards({ status, now }: { status: ClimateImportStatus | null; now: number }) {
  if (!status) return null
  const last = status.last_success
  const behindH = status.latest_hour ? Math.round((now - Date.parse(status.latest_hour)) / 3_600_000) : null
  return (
    <div className={styles.statusGrid}>
      <div className={styles.stat}>
        <div className={styles.statLabel}>Last successful import</div>
        <div className={styles.statValue}>{last ? ago(last.received_at, now) : 'None yet'}</div>
        {last && (
          <div className={styles.statSub}>
            {last.hour_local?.slice(0, 16)} · {last.channel === 'agent' ? 'agent' : 'manual'}
          </div>
        )}
      </div>
      <div className={styles.stat}>
        <div className={styles.statLabel}>Latest hour with data</div>
        <div className={`${styles.statValue} ${behindH !== null && behindH > 2 ? styles.stale : ''}`}>{status.latest_hour ? localTime(status.latest_hour) : '—'}</div>
        {behindH !== null && behindH > 2 && <div className={styles.statSub}>{behindH} h behind</div>}
      </div>
      <div className={styles.stat}>
        <div className={styles.statLabel}>To review</div>
        <div className={`${styles.statValue} ${status.to_review > 0 ? styles.partial : ''}`}>{status.to_review}</div>
        <div className={styles.statSub}>
          {status.files?.conflict ?? 0} conflicts · {status.files?.none ?? 0} quarantined
        </div>
      </div>
      <div className={styles.stat}>
        <div className={styles.statLabel}>Missing hours (7 days)</div>
        <div className={`${styles.statValue} ${status.missing_7d > 0 ? styles.partial : ''}`}>{status.missing_7d}</div>
        <div className={styles.statSub}>hours without an accepted file</div>
      </div>
      <div className={styles.stat}>
        <div className={styles.statLabel}>Uploads (7 days)</div>
        <div className={styles.statValue}>{status.attempts_7d?.created ?? 0}</div>
        <div className={styles.statSub}>
          new · {status.attempts_7d?.duplicate ?? 0} duplicates · {(status.attempts_7d?.conflict ?? 0) + (status.attempts_7d?.quarantined ?? 0)} to review
        </div>
      </div>
      <div className={styles.stat}>
        <div className={styles.statLabel}>Agent last connected</div>
        <div className={styles.statValue}>{ago(status.agent_last_used, now)}</div>
        <div className={styles.statSub}>files in use: {status.files?.active ?? 0}</div>
      </div>
    </div>
  )
}
