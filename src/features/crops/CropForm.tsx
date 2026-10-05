import { useState, type FormEvent, type ReactNode } from 'react'
import { daysBetween, isIsoDate } from '../../lib/dates'
import { formatInteger } from '../../lib/format'
import { ColorDot } from './CropBadges'
import { CROP_COLORS } from './model'
import { validateCropForm, type CropFormErrors, type CropFormField, type CropFormValues, type CropInput } from './cropValidation'
import styles from './CropForm.module.css'

type CropFormProps = {
  initialValues: CropFormValues
  submitLabel: string
  submitting: boolean
  serverError?: string | null
  onSubmit: (input: CropInput) => void
  onCancel: () => void
}

export function CropForm({ initialValues, submitLabel, submitting, serverError, onSubmit, onCancel }: CropFormProps) {
  const [values, setValues] = useState(initialValues)
  const [errors, setErrors] = useState<CropFormErrors>({})
  const [submitted, setSubmitted] = useState(false)

  function set<F extends CropFormField>(field: F, value: CropFormValues[F]) {
    const next = { ...values, [field]: value }
    setValues(next)
    // Once the user has tried to save, keep errors in sync as they fix them.
    if (submitted) {
      const result = validateCropForm(next)
      setErrors('errors' in result ? result.errors : {})
    }
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setSubmitted(true)
    const result = validateCropForm(values)
    if ('errors' in result) return setErrors(result.errors)
    setErrors({})
    onSubmit(result.data)
  }

  const seasonDays =
    isIsoDate(values.planting_date) && isIsoDate(values.pullout_date) ? daysBetween(values.planting_date, values.pullout_date) : null

  return (
    <form className="form" onSubmit={handleSubmit} noValidate>
      <Field label="Variety name" error={errors.name}>
        <input
          className="input input-lg"
          value={values.name}
          onChange={(e) => set('name', e.target.value)}
          placeholder="e.g. Cadalora"
          maxLength={100}
          autoFocus
          autoComplete="off"
          aria-invalid={Boolean(errors.name)}
        />
      </Field>

      <fieldset className={styles.colorFieldset} aria-invalid={Boolean(errors.color)}>
        <legend className="field-label">Color</legend>
        <div className={styles.colorOptions}>
          {CROP_COLORS.map((c) => (
            <label key={c.value} className={styles.colorOption}>
              <input type="radio" name="color" value={c.value} checked={values.color === c.value} onChange={() => set('color', c.value)} />
              <span className={styles.colorChip}>
                <ColorDot color={c.value} />
                {c.label}
              </span>
            </label>
          ))}
        </div>
        {errors.color && <p className="field-error">{errors.color}</p>}
      </fieldset>

      <div className="form-row">
        <Field label="Planting date" error={errors.planting_date}>
          <input className="input" type="date" value={values.planting_date} onChange={(e) => set('planting_date', e.target.value)} aria-invalid={Boolean(errors.planting_date)} />
        </Field>
        <Field label="Pullout date" error={errors.pullout_date} hint={seasonDays && seasonDays > 0 ? `${formatInteger(seasonDays)}-day season` : undefined}>
          <input className="input" type="date" value={values.pullout_date} onChange={(e) => set('pullout_date', e.target.value)} aria-invalid={Boolean(errors.pullout_date)} />
        </Field>
      </div>

      <div className="form-row">
        <Field label="Total growing area" error={errors.area_m2}>
          <div className="input-affix">
            <input className="input" inputMode="decimal" value={values.area_m2} onChange={(e) => set('area_m2', e.target.value)} placeholder="31,114" autoComplete="off" aria-invalid={Boolean(errors.area_m2)} />
            <span className="input-suffix">m²</span>
          </div>
        </Field>
        <Field label="Total picking stems" error={errors.picking_stems}>
          <input className="input" inputMode="numeric" value={values.picking_stems} onChange={(e) => set('picking_stems', e.target.value)} placeholder="76,000" autoComplete="off" aria-invalid={Boolean(errors.picking_stems)} />
        </Field>
      </div>

      {serverError && <p className="form-error" role="alert">{serverError}</p>}

      <div className="form-actions">
        <button type="button" className="button button-secondary" onClick={onCancel} disabled={submitting}>
          Cancel
        </button>
        <button type="submit" className="button button-primary" disabled={submitting}>
          {submitting ? 'Saving…' : submitLabel}
        </button>
      </div>
    </form>
  )
}

function Field({ label, error, hint, children }: { label: string; error?: string; hint?: string; children: ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {error ? <span className="field-error">{error}</span> : hint && <span className="field-hint">{hint}</span>}
    </label>
  )
}
