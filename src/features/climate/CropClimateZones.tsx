// A planting's climate zones (Settings › variety page): which zones it
// occupies from which date, with optional area shares. A change applies from a
// chosen date on; earlier periods stay as they were, and corrections keep the
// earlier record (when it was recorded and when it was replaced).

import { useMemo, useState } from 'react'
import { Dialog } from '../../components/Dialog'
import { ErrorState, LoadingState } from '../../components/States'
import { formatDate, todayIso } from '../../lib/dates'
import type { ClimateZoneRow, CropClimateZoneRow } from '../../lib/database.types'
import type { Crop } from '../crops/model'
import { useOrganization } from '../organization/OrganizationProvider'
import { useClimateSource, useClimateZones, useCropClimateZones, useSetCropClimateZones } from './api'
import { assignmentsOn, parseAreaShares, sortZones, zoneName } from './model'
import page from '../crops/CropDetailPage.module.css'
import styles from './Climate.module.css'

export function CropClimateZones({ crop }: { crop: Crop }) {
  const organization = useOrganization()
  const owner = organization.role === 'owner'
  const source = useClimateSource(organization.id)
  const zonesQ = useClimateZones(source.data?.id)
  const rows = useCropClimateZones(crop.id)
  const [editing, setEditing] = useState(false)
  const [showCorrections, setShowCorrections] = useState(false)

  const zones = useMemo(() => sortZones(zonesQ.data ?? []), [zonesQ.data])
  const zoneById = new Map(zones.map((z) => [z.id, z]))
  const label = (id: string) => (zoneById.get(id) ? zoneName(zoneById.get(id)!) : '?')
  const current = (rows.data ?? []).filter((r) => r.superseded_at === null)
  const today = todayIso()
  const now = assignmentsOn(current, today)

  // Periods: rows in effect, grouped by start date (and end date).
  const periods = groupPeriods(current)
  const corrections = (rows.data ?? []).filter((r) => r.superseded_at !== null)

  return (
    <section className={page.panel}>
      <div className={styles.sectionHead}>
        <h2 className={page.sectionTitle}>Climate zones</h2>
        {owner && source.data && (
          <button type="button" className="button button-secondary" onClick={() => setEditing(true)} disabled={zones.length === 0}>
            Edit zones
          </button>
        )}
      </div>
      {source.isPending || rows.isPending ? (
        <LoadingState />
      ) : rows.error ? (
        <ErrorState error={rows.error} />
      ) : !source.data ? (
        <p className={`${styles.small} ${styles.muted}`}>Climate data isn’t set up yet (Settings › Climate).</p>
      ) : (
        <>
          <div className={styles.chips}>
            {now.length === 0 ? (
              <span className={styles.muted}>No zones assigned today.</span>
            ) : (
              now.map((a) => (
                <span key={a.zone_id} className={`${styles.chip} ${styles.chipStatic}`} title={zoneById.get(a.zone_id)?.source_label}>
                  {label(a.zone_id)}
                  {a.area_share !== null && <span className={styles.muted}>{pct(a.area_share)}</span>}
                </span>
              ))
            )}
          </div>
          <p className={`${styles.small} ${styles.muted}`}>
            Only these zones’ readings are used for this planting, by date. {zones.length === 0 && 'Zones appear once the first climate file is imported.'}
          </p>
          {periods.length > 0 && (
            <details>
              <summary className={styles.small}>History ({periods.length} period{periods.length === 1 ? '' : 's'})</summary>
              <div className={styles.tableWrap}>
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th>From</th>
                      <th className={styles.left}>Until</th>
                      <th className={styles.left}>Zones</th>
                      <th className={`${styles.left} ${styles.hideNarrow}`}>Reason</th>
                    </tr>
                  </thead>
                  <tbody>
                    {periods.map((p) => (
                      <tr key={`${p.from}|${p.until}`}>
                        <td>{formatDate(p.from)}</td>
                        <td className={styles.left}>{p.until ? formatDate(p.until) : 'open'}</td>
                        <td className={styles.left}>{p.rows.map((r) => `${label(r.zone_id)}${r.area_share !== null ? ` ${pct(r.area_share)}` : ''}`).join(', ')}</td>
                        <td className={`${styles.left} ${styles.hideNarrow} ${styles.small}`}>{[...new Set(p.rows.map((r) => r.reason).filter(Boolean))].join('; ')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {corrections.length > 0 && (
                <>
                  <button type="button" className={`button button-secondary ${styles.small}`} onClick={() => setShowCorrections((s) => !s)}>
                    {showCorrections ? 'Hide' : 'Show'} replaced records ({corrections.length})
                  </button>
                  {showCorrections && (
                    <table className={styles.table}>
                      <thead>
                        <tr>
                          <th>Zone</th>
                          <th className={styles.left}>Was valid</th>
                          <th className={styles.left}>Recorded</th>
                          <th className={styles.left}>Replaced</th>
                        </tr>
                      </thead>
                      <tbody>
                        {corrections.map((r) => (
                          <tr key={r.id}>
                            <td>
                              {label(r.zone_id)}
                              {r.area_share !== null && ` ${pct(r.area_share)}`}
                            </td>
                            <td className={styles.left}>
                              {formatDate(r.valid_from)} – {r.valid_until ? formatDate(r.valid_until) : 'open'}
                            </td>
                            <td className={styles.left}>{new Date(r.recorded_at).toLocaleString()}</td>
                            <td className={styles.left}>{new Date(r.superseded_at!).toLocaleString()}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </>
              )}
            </details>
          )}
        </>
      )}
      {editing && (
        <EditZones
          crop={crop}
          zones={zones}
          current={current}
          onClose={() => setEditing(false)}
          initialFrom={clamp(today, crop.planting_date, prevDay(crop.pullout_date))}
        />
      )}
    </section>
  )
}

const pct = (share: number) => `${Math.round(Number(share) * 1000) / 10}%`
const prevDay = (iso: string) => new Date(Date.parse(`${iso}T00:00:00Z`) - 86400000).toISOString().slice(0, 10)
const clamp = (d: string, lo: string, hi: string) => (d < lo ? lo : d > hi ? hi : d)

function groupPeriods(rows: CropClimateZoneRow[]) {
  const map = new Map<string, { from: string; until: string | null; rows: CropClimateZoneRow[] }>()
  for (const r of rows) {
    const k = `${r.valid_from}|${r.valid_until ?? ''}`
    const p = map.get(k) ?? { from: r.valid_from, until: r.valid_until, rows: [] }
    p.rows.push(r)
    map.set(k, p)
  }
  return [...map.values()].sort((a, b) => b.from.localeCompare(a.from))
}

function EditZones({
  crop,
  zones,
  current,
  initialFrom,
  onClose,
}: {
  crop: Crop
  zones: ClimateZoneRow[]
  current: CropClimateZoneRow[]
  initialFrom: string
  onClose: () => void
}) {
  const set = useSetCropClimateZones(crop.id)
  const [from, setFrom] = useState(initialFrom)
  const inEffect = assignmentsOn(current, from)
  const [checked, setChecked] = useState<Set<string>>(() => new Set(inEffect.map((a) => a.zone_id)))
  const [shares, setShares] = useState<Record<string, string>>(() =>
    Object.fromEntries(inEffect.filter((a) => a.area_share !== null).map((a) => [a.zone_id, String(Math.round(Number(a.area_share) * 10000) / 100)])),
  )
  const [reason, setReason] = useState('')
  const selected = zones.filter((z) => checked.has(z.id))
  const parsed = parseAreaShares(selected.map((z) => shares[z.id]))
  const error = 'error' in parsed ? parsed.error : null
  const lastDay = prevDay(crop.pullout_date)
  const dateError = from < crop.planting_date || from > lastDay ? `Choose a date within the planting (${formatDate(crop.planting_date)} – ${formatDate(lastDay)}).` : null

  return (
    <Dialog open title={`Climate zones · ${crop.name}`} onClose={onClose} className={styles.wideDialog}>
      <form
        className={styles.form}
        onSubmit={(e) => {
          e.preventDefault()
          if (error || dateError || 'error' in parsed) return
          set.mutate(
            { from, zones: selected.map((z, i) => ({ zone_id: z.id, area_share: parsed.shares[i] })), reason: reason.trim() },
            { onSuccess: onClose },
          )
        }}
      >
        <label className="field">
          <span className="field-label">Applies from</span>
          <input className="input" type="date" value={from} min={crop.planting_date} max={lastDay} required onChange={(e) => setFrom(e.target.value)} />
          <span className={`${styles.small} ${styles.muted}`}>Days before this keep their zones. From this day on, the planting uses exactly the zones below.</span>
        </label>
        <div>
          <div className={styles.zoneRow}>
            <span className="field-label">Zones</span>
            <span className="field-label">Area % (optional)</span>
          </div>
          <div className={styles.zoneList} style={{ maxHeight: 320, overflowY: 'auto' }}>
            {zones.map((z) => (
              <div key={z.id} className={styles.zoneRow}>
                <label>
                  <input
                    type="checkbox"
                    checked={checked.has(z.id)}
                    onChange={(e) =>
                      setChecked((prev) => {
                        const n = new Set(prev)
                        if (e.target.checked) n.add(z.id)
                        else n.delete(z.id)
                        return n
                      })
                    }
                  />
                  {zoneName(z)}
                  {z.display_name && <span className={styles.muted}>({z.source_label})</span>}
                </label>
                <input
                  className={`input ${styles.shareInput}`}
                  inputMode="decimal"
                  aria-label={`Area % in ${z.source_label}`}
                  disabled={!checked.has(z.id)}
                  value={checked.has(z.id) ? (shares[z.id] ?? '') : ''}
                  onChange={(e) => setShares((s) => ({ ...s, [z.id]: e.target.value }))}
                  placeholder="—"
                />
              </div>
            ))}
          </div>
          <p className={`${styles.small} ${styles.muted}`}>
            Leave area % blank if unknown: each zone is then shown separately, and any combined value is labelled unweighted. If you give them, give one for
            every zone, adding up to 100.
          </p>
        </div>
        <label className="field">
          <span className="field-label">Reason (optional)</span>
          <input className="input" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Moved into Zones 8–9 for the 2027 crop" />
        </label>
        {(error || dateError) && <p className="field-error">{dateError ?? error}</p>}
        {set.error && <p className="field-error">{set.error.message}</p>}
        <div className={styles.actions}>
          <button type="button" className="button button-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="button button-primary" disabled={set.isPending || Boolean(error) || Boolean(dateError)}>
            {set.isPending ? 'Saving…' : selected.length === 0 ? 'Save: no zones from this date' : `Save ${selected.length} zone${selected.length === 1 ? '' : 's'}`}
          </button>
        </div>
      </form>
    </Dialog>
  )
}
