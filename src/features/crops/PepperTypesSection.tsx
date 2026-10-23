import { useState } from 'react'
import { ErrorState, LoadingState } from '../../components/States'
import { useOrganization } from '../organization/OrganizationProvider'
import { useCrops, usePepperTypes, useUpdatePepperType, type PepperType } from './api'
import { formatTiming, parseAfwGrams, parsePercent, parseTiming } from './pepperTypes'
import styles from './VarietiesSection.module.css'

/**
 * Settings › Pepper types: the forecasting model groups. Each variety learns
 * and falls back on assumptions only within its own pepper type. Owners set
 * the provisional assumptions used before a type has enough history; empty
 * means not configured (the outlook then shows no estimate rather than
 * borrowing another type's values).
 */
export function PepperTypesSection() {
  const organization = useOrganization()
  const types = usePepperTypes(organization.id)
  const crops = useCrops(organization.id)
  return (
    <section className={styles.section} aria-labelledby="pepper-types-heading">
      <div className={styles.header}>
        <div>
          <h2 id="pepper-types-heading" className={styles.title}>Pepper types</h2>
          <p className={styles.description}>
            Forecasting model groups. Each variety learns from, and falls back on, only its own pepper type, so bell and long pointed peppers never
            influence each other. Provisional assumptions apply until a variety has enough completed cohorts; empty means not configured.
          </p>
        </div>
      </div>
      {types.isPending ? (
        <LoadingState />
      ) : types.error ? (
        <ErrorState error={types.error} />
      ) : (
        <div className={styles.typeList}>
          {types.data.map((t) => (
            <PepperTypeCard
              key={t.id}
              type={t}
              varieties={(crops.data ?? []).filter((c) => c.pepper_type_id === t.id).map((c) => c.name)}
              canEdit={organization.role === 'owner'}
            />
          ))}
        </div>
      )}
    </section>
  )
}

function PepperTypeCard({ type, varieties, canEdit }: { type: PepperType; varieties: string[]; canEdit: boolean }) {
  const organization = useOrganization()
  const update = useUpdatePepperType(organization.id)
  const [editing, setEditing] = useState(false)
  const [survival, setSurvival] = useState('')
  const [timing, setTiming] = useState('')
  const [afw, setAfw] = useState('')
  const [pool, setPool] = useState(false)
  const start = () => {
    setSurvival(type.provisional_survival === null ? '' : String(Math.round(type.provisional_survival * 1000) / 10))
    setTiming(formatTiming(type.provisional_timing))
    setAfw(type.default_afw_g === null ? '' : String(type.default_afw_g))
    setPool(type.pool_within_type)
    update.reset()
    setEditing(true)
  }
  const s = parsePercent(survival)
  const t = parseTiming(timing)
  const a = parseAfwGrams(afw)
  const problems = [('error' in s && s.error) || null, ('error' in t && t.error) || null, ('error' in a && a.error) || null].filter(Boolean)
  const save = () => {
    if (problems.length || 'error' in s || 'error' in t || 'error' in a) return
    update.mutate(
      { id: type.id, change: { provisional_survival: s.value, provisional_timing: t.shares, default_afw_g: a.value, pool_within_type: pool } },
      { onSuccess: () => setEditing(false) },
    )
  }
  const notSet = <span className={styles.notConfigured}>not configured</span>
  return (
    <article className={styles.typeCard} aria-label={type.name}>
      <div className={styles.typeHead}>
        <h3 className={styles.groupTitle}>{type.name}</h3>
        {canEdit && !editing && (
          <button type="button" className="button button-secondary" onClick={start}>
            Edit assumptions
          </button>
        )}
      </div>
      <p className={styles.description}>Varieties: {varieties.length ? varieties.join(', ') : 'none yet'}</p>
      {editing ? (
        <form
          className="form"
          onSubmit={(e) => {
            e.preventDefault()
            save()
          }}
        >
          <label className="field">
            <span className="field-label">Provisional survival %</span>
            <input className="input" inputMode="decimal" value={survival} onChange={(e) => setSurvival(e.target.value)} placeholder="not configured" />
            <span className="field-hint">Share of set peppers harvested, until varieties of this type have enough completed cohorts.</span>
          </label>
          <label className="field">
            <span className="field-label">Provisional harvest timing</span>
            <input className="input" value={timing} onChange={(e) => setTiming(e.target.value)} placeholder="e.g. 5:20, 6:30, 7:30, 8:20" />
            <span className="field-hint">Weeks after set : % of the harvest, adding up to 100%.</span>
          </label>
          <label className="field">
            <span className="field-label">Default AFW (g)</span>
            <input className="input" inputMode="decimal" value={afw} onChange={(e) => setAfw(e.target.value)} placeholder="none" />
            <span className="field-hint">Used only for a variety of this type with no AFW entered yet.</span>
          </label>
          <label className={styles.checkRow}>
            <input type="checkbox" checked={pool} onChange={(e) => setPool(e.target.checked)} />
            Let a variety without enough history use the completed cohorts of other {type.name} varieties (never other pepper types)
          </label>
          {problems.map((p) => (
            <p key={p} className="field-error">
              {p}
            </p>
          ))}
          {update.error && <p className="form-error">{update.error.message}</p>}
          <div className="form-actions">
            <button type="button" className="button button-secondary" onClick={() => setEditing(false)} disabled={update.isPending}>
              Cancel
            </button>
            <button type="submit" className="button button-primary" disabled={update.isPending || problems.length > 0}>
              {update.isPending ? 'Saving…' : 'Save assumptions'}
            </button>
          </div>
        </form>
      ) : (
        <dl className={styles.typeStats}>
          <div>
            <dt>Provisional survival</dt>
            <dd>{type.provisional_survival === null ? notSet : `${Math.round(type.provisional_survival * 1000) / 10}%`}</dd>
          </div>
          <div>
            <dt>Provisional timing (weeks : %)</dt>
            <dd>{type.provisional_timing === null ? notSet : formatTiming(type.provisional_timing)}</dd>
          </div>
          <div>
            <dt>Default AFW</dt>
            <dd>{type.default_afw_g === null ? 'none' : `${type.default_afw_g} g`}</dd>
          </div>
          <div>
            <dt>Learn from other {type.name} varieties</dt>
            <dd>{type.pool_within_type ? 'Yes' : 'No'}</dd>
          </div>
        </dl>
      )}
    </article>
  )
}
