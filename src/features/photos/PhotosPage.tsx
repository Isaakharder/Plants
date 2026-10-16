import { useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Dialog } from '../../components/Dialog'
import { EmptyState, ErrorState, LoadingState } from '../../components/States'
import type { NodePhotoRow } from '../../lib/database.types'
import { currentGreenhouseWeek } from '../collector/greenhouseWeek'
import { useCrops } from '../crops/api'
import { sortCrops, type Crop } from '../crops/model'
import { useOrganization } from '../organization/OrganizationProvider'
import { addColourEstimate, addPairCorrection, usePhotoImage, usePhotoPairs, useRefreshPhotos, type PhotoData } from './api'
import { assignmentCheck, combinedPercent, nodeName, parsePercent, type PhotoPair } from './model'
import styles from './PhotosPage.module.css'

const PERIODS = [
  { value: '2', label: 'Last 2 weeks' },
  { value: '4', label: 'Last 4 weeks' },
  { value: '8', label: 'Last 8 weeks' },
  { value: 'all', label: 'All weeks' },
] as const

const dateTime = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { timeZone: 'America/Toronto', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })

/** The ISO week `weeks` − 1 weeks before the current greenhouse week. */
function since(weeks: number): { year: number; week: number } {
  const { year, week } = currentGreenhouseWeek()
  const monday = new Date(Date.UTC(year, 0, 4))
  monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() || 7) - 1) + (week - 1) * 7 - (weeks - 1) * 7)
  const thursday = new Date(monday)
  thursday.setUTCDate(monday.getUTCDate() + 3)
  const y = thursday.getUTCFullYear()
  return { year: y, week: Math.floor((thursday.getTime() - Date.UTC(y, 0, 1)) / 86_400_000 / 7) + 1 }
}

/**
 * Photos › Breaker photo pairs: the front and back photos of each Breaker
 * record, where the pepper was, a quick manual colour estimate (to build a
 * verified dataset) and node corrections. Nothing is ever changed or deleted:
 * estimates and corrections are added as new records.
 */
export function PhotosPage() {
  const organization = useOrganization()
  const crops = useCrops(organization.id)
  const [params, setParams] = useSearchParams()
  const sorted = useMemo(() => sortCrops(crops.data ?? []), [crops.data])
  const crop = sorted.find((c) => c.id === params.get('crop')) ?? sorted[0]
  const period = (PERIODS.find((p) => p.value === params.get('period')) ?? PERIODS[1]).value
  const onlyMissing = params.get('missing') === '1'
  const data = usePhotoPairs(crop, period === 'all' ? null : since(Number(period)))
  const set = (key: string, value: string | null) =>
    setParams(
      (prev) => {
        const p = new URLSearchParams(prev)
        if (value === null) p.delete(key)
        else p.set(key, value)
        return p
      },
      { replace: true },
    )

  if (crops.isPending) return <LoadingState />
  if (crops.error) return <ErrorState error={crops.error} />
  if (!crop) return <EmptyState title="No varieties yet" description="Add a variety in Settings." />

  const pairs = (data.data?.pairs ?? []).filter((p) => !onlyMissing || (!p.colour && p.assignment.kind !== 'unusable' && p.assignment.kind !== 'duplicate'))
  return (
    <section className={styles.page} aria-label="Breaker photos">
      <h1 className="visually-hidden">Breaker photos</h1>
      <div className={styles.toolbar}>
        <label className="field">
          <span className="field-label">Variety</span>
          <select className="input" value={crop.id} onChange={(e) => set('crop', e.target.value)}>
            {sorted.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field-label">Period</span>
          <select className="input" value={period} onChange={(e) => set('period', e.target.value)}>
            {PERIODS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
        <label className={styles.check}>
          <input type="checkbox" checked={onlyMissing} onChange={(e) => set('missing', e.target.checked ? '1' : null)} />
          Only pairs without a colour %
        </label>
        <span className={styles.count}>{data.data ? `${pairs.length} photo pair${pairs.length === 1 ? '' : 's'}` : ''}</span>
      </div>

      {data.isPending ? (
        <LoadingState />
      ) : data.error ? (
        <ErrorState error={data.error} />
      ) : pairs.length === 0 ? (
        <EmptyState
          title={onlyMissing ? 'Every photo pair has a colour %' : `No Breaker photos for ${crop.name} in this period`}
          description="Photos appear here once a worker records a Breaker with the camera in the mobile collector, and the phone has synced."
        />
      ) : (
        <div className={styles.grid}>
          {pairs.map((p) => (
            <PairCard key={p.observationId} pair={p} crop={crop} data={data.data!} />
          ))}
        </div>
      )}
    </section>
  )
}

function Thumb({ photo, label, onOpen }: { photo: NodePhotoRow | null; label: string; onOpen: (p: NodePhotoRow) => void }) {
  // The preview when there is one; else the original.
  const image = usePhotoImage(photo ? (photo.preview_path ?? photo.storage_path) : null)
  if (!photo) return <div className={styles.thumbMissing}>No {label.toLowerCase()} photo</div>
  return (
    <button type="button" className={styles.thumb} onClick={() => onOpen(photo)} title={`Open the full-size ${label.toLowerCase()} photo`}>
      {image.data ? <img src={image.data} alt={`${label} photo`} /> : <span className={styles.thumbLoading}>{image.error ? 'Couldn’t load' : 'Loading…'}</span>}
      <span className={styles.thumbLabel}>{label}</span>
    </button>
  )
}

const HEIC = new Set(['image/heic', 'image/heif'])

function FullSize({ photo, onClose }: { photo: NodePhotoRow; onClose: () => void }) {
  // Most desktop browsers can't display HEIC: show the preview large and offer the original as a download.
  const heic = HEIC.has(photo.content_type)
  const image = usePhotoImage(heic ? (photo.preview_path ?? null) : photo.storage_path)
  const original = usePhotoImage(heic ? photo.storage_path : null)
  return (
    <Dialog open title={`${photo.side === 'front' ? 'Front' : 'Back'} · ${nodeName(photo)}`} onClose={onClose} className={styles.fullDialog}>
      {image.data ? (
        <img className={styles.full} src={image.data} alt={`${photo.side} photo${heic ? ' (preview)' : ', full size'}`} />
      ) : heic && !photo.preview_path ? (
        <p>This photo is in HEIC format, which this browser can’t show, and the phone made no preview.</p>
      ) : (
        <p>{image.error ? image.error.message : 'Loading…'}</p>
      )}
      {heic && original.data && (
        <p>
          <a className="button button-secondary" href={original.data} download={`${photo.id}.${photo.content_type === 'image/heif' ? 'heif' : 'heic'}`}>
            Download original (HEIC)
          </a>
        </p>
      )}
      <p className={styles.fullMeta}>
        Taken {dateTime(photo.taken_at)} · {(photo.bytes / 1_000_000).toFixed(1)} MB
        {photo.width && photo.height ? ` · ${photo.width} × ${photo.height}` : ''} · SHA-256 {photo.sha256.slice(0, 12)}…
      </p>
    </Dialog>
  )
}

const when = (o: { observedAt: string | null; takenAt: string } | undefined) => (o ? dateTime(o.observedAt ?? o.takenAt) : 'another record')

/** Earlier photos replaced from the collector: kept, shown small, with why they were replaced. */
function Replaced({ pair, onOpen }: { pair: PhotoPair; onOpen: (p: NodePhotoRow) => void }) {
  const current = [pair.front, pair.back].filter((p): p is NodePhotoRow => p !== null)
  return (
    <div className={styles.replaced}>
      <span className={styles.note}>Replaced (kept for the record):</span>
      {pair.replaced.map((old) => {
        const by = [...current, ...pair.replaced].find((p) => p.replaces_photo_id === old.id)
        const reason = by?.capture_meta?.replaceReason
        return (
          <span key={old.id} className={styles.replacedItem}>
            <Thumb photo={old} label={old.side === 'front' ? 'Old front' : 'Old back'} onOpen={onOpen} />
            {typeof reason === 'string' && <span className={styles.note}>{reason}</span>}
          </span>
        )
      })}
    </div>
  )
}

function PairCard({ pair, crop, data }: { pair: PhotoPair; crop: Crop; data: PhotoData }) {
  const refresh = useRefreshPhotos()
  const [open, setOpen] = useState<NodePhotoRow | null>(null)
  const [mode, setMode] = useState<'none' | 'colour' | 'node'>('none')
  const c = pair.colour
  return (
    <article className={`${styles.card} ${pair.assignment.kind === 'unusable' || pair.assignment.kind === 'duplicate' ? styles.unusable : ''}`}>
      <header className={styles.cardHead}>
        <strong>
          W{pair.week} · {dateTime(pair.observedAt ?? pair.takenAt)}
        </strong>
        {pair.assignment.kind === 'reassign_node' && <span className={styles.badge}>Reassigned</span>}
        {pair.assignment.kind === 'unusable' && <span className={`${styles.badge} ${styles.badgeBad}`}>Unusable</span>}
        {pair.assignment.kind === 'duplicate' && <span className={`${styles.badge} ${styles.badgeBad}`}>Duplicate</span>}
        {pair.replaced.length > 0 && <span className={styles.badge}>Photos replaced</span>}
      </header>
      <div className={styles.thumbs}>
        <Thumb photo={pair.front} label="Front" onOpen={setOpen} />
        <Thumb photo={pair.back} label="Back" onOpen={setOpen} />
      </div>
      {pair.replaced.length > 0 && <Replaced pair={pair} onOpen={setOpen} />}
      <dl className={styles.meta}>
        <dt>Variety</dt>
        <dd>{crop.name}</dd>
        <dt>Recorded on</dt>
        <dd>
          {pair.atCapture.rowName} · {pair.atCapture.stemName} · {pair.atCapture.nodeName}
        </dd>
        {pair.assignment.kind === 'reassign_node' && (
          <>
            <dt>Photos show</dt>
            <dd>
              {pair.assignment.node ? `${pair.assignment.node.rowName} · ${pair.assignment.node.stemName} · ${pair.assignment.node.nodeName}` : 'another node'}
              {pair.assignment.note && <span className={styles.note}> — {pair.assignment.note}</span>}
            </dd>
          </>
        )}
        <dt>Colour</dt>
        <dd>
          {c ? (
            <>
              <strong>{Number(c.combined_percent)}%</strong>
              {(c.front_percent !== null || c.back_percent !== null) && (
                <span className={styles.note}>
                  {' '}
                  (front {c.front_percent === null ? '—' : Number(c.front_percent)} · back {c.back_percent === null ? '—' : Number(c.back_percent)})
                </span>
              )}
              {pair.colourHistory.length > 1 && <span className={styles.note}> · corrected ({pair.colourHistory.length} entries)</span>}
            </>
          ) : (
            <span className={styles.note}>not estimated yet</span>
          )}
        </dd>
      </dl>
      {pair.assignment.kind === 'reassign_node' && pair.assignment.nodeId && pair.assignment.node && (() => {
        const check = assignmentCheck(
          pair.atCapture.nodeName,
          data.statuses.get(pair.recordedNodeId),
          pair.assignment.node.nodeName,
          data.statuses.get(pair.assignment.nodeId),
        )
        return <p className={check.ok ? styles.agree : styles.disagree}>{check.ok ? '✓ ' : '⚠ '}{check.message}</p>
      })()}
      {pair.assignment.kind === 'duplicate' ? (
        <p className={styles.disagree}>
          Duplicate of the Breaker recorded {when(pair.sameNodeWeek.find((o) => o.observationId === pair.assignment.duplicateOf))}: the same pepper recorded twice. Both records and
          their photos are kept; only the other one is used.
          {pair.assignment.note && <span className={styles.note}> — {pair.assignment.note}</span>}
        </p>
      ) : (
        (() => {
          // Records not yet marked duplicates: one of them must stay in use.
          const open = pair.sameNodeWeek.filter((o) => !o.markedDuplicate)
          if (pair.sameNodeWeek.length === 0) return null
          if (open.length === 0) {
            return (
              <p className={styles.agree}>
                ✓ Kept: the other Breaker record{pair.sameNodeWeek.length === 1 ? '' : 's'} of {pair.atCapture.nodeName} in W{pair.week} {pair.sameNodeWeek.length === 1 ? 'is' : 'are'} marked
                as {pair.sameNodeWeek.length === 1 ? 'a duplicate' : 'duplicates'}.
              </p>
            )
          }
          return (
            <div className={styles.disagree}>
              <p>
                ⚠ {pair.atCapture.nodeName} has {open.length === 1 ? 'another Breaker record' : `${open.length} other Breaker records`} in W{pair.week} (
                {open.map((o) => when(o)).join(', ')}). A pepper is normally recorded once. If the photos show the same pepper, mark the extra record as a duplicate.
                To replace unclear photos, use “Replace photos” in the collector instead.
              </p>
              <div className={styles.actions}>
                {open.map((o) => (
                  <button
                    key={o.observationId}
                    type="button"
                    className="button button-secondary"
                    onClick={async () => {
                      await addPairCorrection(pair, 'duplicate', null, 'Same pepper recorded twice', o.observationId)
                      void refresh()
                    }}
                  >
                    Mark this one a duplicate of {when(o)}
                  </button>
                ))}
              </div>
            </div>
          )
        })()
      )}
      {mode === 'colour' ? (
        <ColourForm pair={pair} onDone={() => { setMode('none'); void refresh() }} onCancel={() => setMode('none')} />
      ) : mode === 'node' ? (
        <NodeForm pair={pair} data={data} onDone={() => { setMode('none'); void refresh() }} onCancel={() => setMode('none')} />
      ) : (
        <div className={styles.actions}>
          {pair.assignment.kind !== 'unusable' && pair.assignment.kind !== 'duplicate' && (
            <button type="button" className="button button-primary" onClick={() => setMode('colour')}>
              {c ? 'Correct colour %' : 'Enter colour %'}
            </button>
          )}
          <button type="button" className="button button-secondary" onClick={() => setMode('node')}>
            Wrong node?
          </button>
          {pair.assignment.kind === 'as_captured' ? (
            <button type="button" className="button button-link" onClick={async () => { await addPairCorrection(pair, 'unusable', null, null); void refresh() }}>
              Mark unusable
            </button>
          ) : (
            <button type="button" className="button button-link" onClick={async () => { await addPairCorrection(pair, 'restore', null, null); void refresh() }}>
              Restore as recorded
            </button>
          )}
        </div>
      )}
      {open && <FullSize photo={open} onClose={() => setOpen(null)} />}
    </article>
  )
}

function ColourForm({ pair, onDone, onCancel }: { pair: PhotoPair; onDone: () => void; onCancel: () => void }) {
  const [front, setFront] = useState(pair.colour?.front_percent === null || !pair.colour ? '' : String(Number(pair.colour.front_percent)))
  const [back, setBack] = useState(pair.colour?.back_percent === null || !pair.colour ? '' : String(Number(pair.colour.back_percent)))
  const [combined, setCombined] = useState('')
  const [note, setNote] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const f = parsePercent(front)
  const b = parsePercent(back)
  const t = parsePercent(combined)
  const invalid = f === 'invalid' || b === 'invalid' || t === 'invalid'
  const total = invalid ? null : combinedPercent(f as number | null, b as number | null, t as number | null)
  return (
    <form
      className={styles.form}
      onSubmit={async (e) => {
        e.preventDefault()
        if (invalid || total === null) return
        setSaving(true)
        setError('')
        try {
          await addColourEstimate(pair, { front: f as number | null, back: b as number | null, combined: total, note: note.trim() || null })
          onDone()
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err))
          setSaving(false)
        }
      }}
    >
      <p className={styles.formHint}>Share of the visible surface that has turned {pair.front?.target_colour ?? pair.back?.target_colour}, per photo (0–100).</p>
      <div className={styles.percentRow}>
        <label>
          Front %
          <input className="input" inputMode="decimal" value={front} onChange={(e) => setFront(e.target.value)} autoFocus aria-invalid={f === 'invalid'} />
        </label>
        <label>
          Back %
          <input className="input" inputMode="decimal" value={back} onChange={(e) => setBack(e.target.value)} aria-invalid={b === 'invalid'} />
        </label>
        <label>
          Whole pepper %
          <input
            className="input"
            inputMode="decimal"
            value={combined}
            placeholder={total === null ? '' : String(total)}
            onChange={(e) => setCombined(e.target.value)}
            aria-invalid={t === 'invalid'}
            title="Leave blank to use the mean of front and back"
          />
        </label>
      </div>
      <input className="input" placeholder="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} />
      {invalid && <span className={styles.error}>Percentages are numbers from 0 to 100.</span>}
      {error && <span className={styles.error}>{error}</span>}
      <div className={styles.actions}>
        <button type="submit" className="button button-primary" disabled={saving || invalid || total === null}>
          {saving ? 'Saving…' : pair.colour ? 'Save correction' : 'Save'}
        </button>
        <button type="button" className="button button-secondary" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
      </div>
    </form>
  )
}

function NodeForm({ pair, data, onDone, onCancel }: { pair: PhotoPair; data: PhotoData; onDone: () => void; onCancel: () => void }) {
  const capturedStem = (pair.front ?? pair.back)!.measurement_stem_id
  const [stemId, setStemId] = useState(capturedStem)
  const [nodeId, setNodeId] = useState('')
  const [note, setNote] = useState('')
  const [understood, setUnderstood] = useState(false)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const capturedNode = (pair.front ?? pair.back)!.plant_node_id
  const target = nodeId ? data.statuses.get(nodeId) : undefined
  const nodes = data.nodes
    .filter((n) => n.stemId === stemId && n.id !== capturedNode)
    .sort((a, b) => a.nodeNumber - b.nodeNumber || Number(a.isSideShoot) - Number(b.isSideShoot) || (a.label ?? '').localeCompare(b.label ?? ''))
  return (
    <form
      className={styles.form}
      onSubmit={async (e) => {
        e.preventDefault()
        if (!nodeId) return
        setSaving(true)
        setError('')
        try {
          await addPairCorrection(pair, 'reassign_node', nodeId, note.trim() || null)
          onDone()
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err))
          setSaving(false)
        }
      }}
    >
      <p className={styles.formHint}>
        Which node is the pepper in these photos really on? This only reassigns the photos: the Breaker record, the stages and the photos themselves stay as they
        are.
      </p>
      <div className={styles.percentRow}>
        <label>
          Stem
          <select className="input" value={stemId} onChange={(e) => { setStemId(e.target.value); setNodeId('') }}>
            {data.stems.map((s) => (
              <option key={s.id} value={s.id}>
                {s.rowName} · {s.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Node
          <select className="input" value={nodeId} onChange={(e) => setNodeId(e.target.value)}>
            <option value="">Choose…</option>
            {nodes.map((n) => (
              <option key={n.id} value={n.id}>
                {nodeName(n)}
              </option>
            ))}
          </select>
        </label>
      </div>
      {nodeId && (
        <p className={styles.formHint}>
          That node is recorded as <strong>{target ? `${target.status} (W${target.week})` : 'nothing yet'}</strong>.
          {target?.status !== 'BreakerFruit' && target?.status !== 'Harvested' && ' Record it as Breaker in the collector, or the records will disagree with the photos.'}
        </p>
      )}
      <input className="input" placeholder="Why (optional)" value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} />
      <label className={styles.check}>
        <input type="checkbox" checked={understood} onChange={(e) => setUnderstood(e.target.checked)} />
        I understand this moves only the photos. The Breaker record stays on {pair.atCapture.nodeName}; I’ll correct the stages in the collector if they’re wrong.
      </label>
      {error && <span className={styles.error}>{error}</span>}
      <div className={styles.actions}>
        <button type="submit" className="button button-primary" disabled={saving || !nodeId || !understood}>
          {saving ? 'Saving…' : 'Reassign photos'}
        </button>
        <button type="button" className="button button-secondary" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
      </div>
    </form>
  )
}
