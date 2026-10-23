// Forecast settings of a variety: what the forecast rests on from a week on
// (full lifecycle, or Breakers only). The harvest-ready share (Ready %) of an
// entry applies to its own sampling week only: every new week starts at 100%
// (engine/basis.ts). Settings are append-only: a change is a new entry; the
// timeline shows which entry is in effect from which week, and the history
// keeps every entry.

import { useState } from 'react'
import { Dialog } from '../../components/Dialog'
import type { ForecastBasisSettingRow } from '../../lib/database.types'
import type { Crop } from '../crops/model'
import { useOrganization } from '../organization/OrganizationProvider'
import { addBasisSetting, currentWeek, useBasisSettings, useInvalidateForecasts } from './api'
import { weekIndex, weekOfIndex } from './engine/weeks'
import styles from './HarvestForecastTab.module.css'
import { basisTimeline } from './basisTimeline'

const BASIS_LABEL = { lifecycle: 'Full lifecycle (8 weeks)', breaker_only: 'Breakers only (next week)' } as const

const when = (iso: string) => new Date(iso).toLocaleString(undefined, { timeZone: 'America/Toronto', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })
const describe = (r: ForecastBasisSettingRow) =>
  `${BASIS_LABEL[r.basis]}${r.basis === 'breaker_only' && r.harvest_ready_share !== null ? ` · Ready % ${Math.round(100 * r.harvest_ready_share)}% for W${r.from_week}` : ''}`

const weekBefore = (r: Pick<ForecastBasisSettingRow, 'from_year' | 'from_week'>) => {
  const w = weekOfIndex(weekIndex(r.from_year, r.from_week) - 1)
  return `W${w.week} ${w.year}`
}

export function ForecastSettings({ crop, open, onClose }: { crop: Crop; open: boolean; onClose: () => void }) {
  const organization = useOrganization()
  const settings = useBasisSettings(crop.id)
  const invalidate = useInvalidateForecasts()
  const now = currentWeek()
  const [year, setYear] = useState(String(now.year))
  const [week, setWeek] = useState(String(now.week))
  const [basis, setBasis] = useState<'lifecycle' | 'breaker_only'>('breaker_only')
  const [share, setShare] = useState('100')
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const rows = settings.data ?? []
  const timeline = basisTimeline(rows)
  const y = Number(year)
  const w = Number(week)
  const pct = Number(share.replace(',', '.'))
  const valid = Number.isInteger(y) && y >= 2000 && y <= 2100 && Number.isInteger(w) && w >= 1 && w <= 53 && (basis === 'lifecycle' || (Number.isFinite(pct) && pct >= 0 && pct <= 100))

  return (
    <Dialog open={open} title={`Forecast settings · ${crop.name}`} onClose={onClose} className={styles.auditDialog}>
      <p className={styles.subtitle}>
        What this variety’s forecast rests on, from a week on. <strong>Full lifecycle</strong>: the eight-week forecast from SetFruit, MatureGreen and Breaker
        records. <strong>Breakers only</strong>: the Friday walkthrough records Breakers only, so the forecast covers next week: this Friday’s Breakers × the
        harvest-ready share (<strong>Ready %</strong>). Ready % is chosen per sampling week: every new week starts at 100%, and a value chosen for a week
        (here, in the <strong>Ready %</strong> field before Generate forecast, or saved from a What-if) applies to that week only. Here you choose the basis
        from a week on. Changes are added as new entries; nothing is overwritten, and forecasts already saved or locked keep the Ready % they were made with.
      </p>

      <h3 className={styles.replayTitle}>In effect</h3>
      {settings.isPending ? (
        <p className={styles.fate}>Loading…</p>
      ) : timeline.length === 0 ? (
        <p className={styles.fate}>No setting yet: the next-week forecast from Breakers, with Ready % 100% unless a week has its own.</p>
      ) : (
        <ul className={styles.settingsTimeline}>
          {timeline.map((r, i) => (
            <li key={r.id}>
              <strong>
                From W{r.from_week} {r.from_year}
                {timeline[i + 1] ? ` to ${weekBefore(timeline[i + 1])}` : ' on'}
              </strong>
              : {describe(r)}
            </li>
          ))}
        </ul>
      )}

      <form
        className={styles.settingsForm}
        onSubmit={async (e) => {
          e.preventDefault()
          if (!valid) return
          setSaving(true)
          setError(null)
          try {
            await addBasisSetting({ organizationId: organization.id, cropId: crop.id, fromYear: y, fromWeek: w, basis, share: basis === 'breaker_only' ? pct / 100 : null, note: note.trim() || null })
            await Promise.all([settings.refetch(), invalidate()])
            setNote('')
          } catch (err) {
            setError(err instanceof Error ? err.message : String(err))
          } finally {
            setSaving(false)
          }
        }}
      >
        <h3 className={styles.replayTitle}>Add a change</h3>
        <div className={styles.settingsRow}>
          <label className="field">
            <span className="field-label">From year</span>
            <input className="input" inputMode="numeric" value={year} onChange={(e) => setYear(e.target.value)} />
          </label>
          <label className="field">
            <span className="field-label">From week</span>
            <input className="input" inputMode="numeric" value={week} onChange={(e) => setWeek(e.target.value)} />
          </label>
          <label className="field">
            <span className="field-label">Basis</span>
            <select className="input" value={basis} onChange={(e) => setBasis(e.target.value as typeof basis)}>
              <option value="breaker_only">{BASIS_LABEL.breaker_only}</option>
              <option value="lifecycle">{BASIS_LABEL.lifecycle}</option>
            </select>
          </label>
          {basis === 'breaker_only' && (
            <label className="field">
              <span className="field-label">Ready % for that week</span>
              <input className="input" inputMode="decimal" value={share} onChange={(e) => setShare(e.target.value)} aria-invalid={!(pct >= 0 && pct <= 100)} />
            </label>
          )}
        </div>
        <input className="input" placeholder="Why (optional)" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
        {error && <div className={styles.error}>{error}</div>}
        <div>
          <button type="submit" className="button button-primary" disabled={!valid || saving}>
            {saving ? 'Saving…' : 'Add change'}
          </button>
        </div>
      </form>

      {rows.length > 0 && (
        <>
          <h3 className={styles.replayTitle}>History</h3>
          <ol className={styles.settingsHistory}>
            {rows.map((r) => (
              <li key={r.id}>
                {when(r.created_at)} · from W{r.from_week} {r.from_year}: {describe(r)}
                {r.note && <span className={styles.groupNote}> — {r.note}</span>}
              </li>
            ))}
          </ol>
        </>
      )}
    </Dialog>
  )
}
