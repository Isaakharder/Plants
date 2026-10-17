// Manual import of Block Summary CSVs (e.g. a copy of the climate PC's
// Uploaded/Failed folders). Each file is sent as is; the server keeps its
// original bytes, parses it, and answers per file: created, duplicate (already
// stored, nothing new), conflict or quarantined (stored for review), or not stored.

import { useState } from 'react'
import { Dialog } from '../../components/Dialog'
import { uploadClimateFiles, useInvalidateClimate, type ManualResult } from './api'
import { StateBadge } from './StateBadge'
import styles from './Climate.module.css'

const MAX_BYTES = 1_048_576

export function ManualImportDialog({ open, sourceId, onClose }: { open: boolean; sourceId: string; onClose: () => void }) {
  const [files, setFiles] = useState<File[]>([])
  const [results, setResults] = useState<ManualResult[]>([])
  const [busy, setBusy] = useState(false)
  const [over, setOver] = useState(false)
  const invalidate = useInvalidateClimate()

  const add = (list: FileList | null) => {
    if (!list) return
    const csv = [...list].filter((f) => f.name.toLowerCase().endsWith('.csv'))
    setFiles((prev) => {
      const seen = new Set(prev.map((f) => `${f.name}|${f.size}|${f.lastModified}`))
      return [...prev, ...csv.filter((f) => !seen.has(`${f.name}|${f.size}|${f.lastModified}`))].sort((a, b) => a.name.localeCompare(b.name))
    })
    setResults([])
  }

  const tooBig = files.filter((f) => f.size > MAX_BYTES)
  const sendable = files.filter((f) => f.size <= MAX_BYTES)
  const counts = results.reduce<Record<string, number>>((acc, r) => ({ ...acc, [r.status]: (acc[r.status] ?? 0) + 1 }), {})

  const start = async () => {
    setBusy(true)
    setResults([])
    try {
      await uploadClimateFiles(sourceId, sendable, (batch) => setResults((prev) => [...prev, ...batch]))
    } finally {
      setBusy(false)
      void invalidate()
    }
  }

  const close = () => {
    if (busy) return
    setFiles([])
    setResults([])
    onClose()
  }

  return (
    <Dialog open={open} title="Import climate CSV files" onClose={close} className={styles.wideDialog}>
      <div className={styles.form}>
        <p className={`${styles.small} ${styles.muted}`}>
          Ridder Synopta “Block Summary” exports. Files already stored are recognised and skipped (duplicates); a different file for an hour that
          already has one is kept for review. Your files aren’t changed.
        </p>
        <label
          className={`${styles.drop} ${over ? styles.over : ''}`}
          onDragOver={(e) => {
            e.preventDefault()
            setOver(true)
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            e.preventDefault()
            setOver(false)
            add(e.dataTransfer.files)
          }}
        >
          <input type="file" accept=".csv,text/csv" multiple hidden onChange={(e) => add(e.target.files)} disabled={busy} />
          Drop CSV files here, or <u>choose files</u>
          {files.length > 0 && <div className={styles.small}>{files.length} selected</div>}
        </label>
        {tooBig.length > 0 && <p className={styles.partial}>{tooBig.length} file(s) over 1 MB will be skipped (not a Block Summary export).</p>}

        {results.length > 0 && (
          <>
            <p className={styles.small}>
              {results.length} of {sendable.length} processed:{' '}
              {Object.entries(counts)
                .map(([k, n]) => `${n} ${k === 'error' ? 'not stored' : k}`)
                .join(' · ')}
            </p>
            <div className={styles.tableWrap} style={{ maxHeight: 320, overflowY: 'auto' }}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>File</th>
                    <th className={styles.left}>Result</th>
                    <th>Hour</th>
                    <th className={`${styles.left} ${styles.hideNarrow}`}>Notes</th>
                  </tr>
                </thead>
                <tbody>
                  {results.map((r, i) => (
                    <tr key={`${r.filename}${i}`}>
                      <td>{r.filename}</td>
                      <td className={styles.left}>
                        <StateBadge state={r.status} />
                      </td>
                      <td>{r.hour_local?.slice(0, 16) ?? '—'}</td>
                      <td className={`${styles.left} ${styles.hideNarrow} ${styles.small}`}>{r.message ?? [...(r.problems ?? []), ...(r.warnings ?? [])].join(', ')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}

        <div className={styles.actions}>
          <button type="button" className="button button-secondary" onClick={close} disabled={busy}>
            {results.length > 0 ? 'Done' : 'Cancel'}
          </button>
          <button type="button" className="button button-primary" onClick={start} disabled={busy || sendable.length === 0}>
            {busy ? `Importing… ${results.length}/${sendable.length}` : `Import ${sendable.length} file${sendable.length === 1 ? '' : 's'}`}
          </button>
        </div>
      </div>
    </Dialog>
  )
}
