import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { EmptyState, ErrorState, LoadingState } from '../../components/States'
import { daysBetween, formatDateLong, todayIso } from '../../lib/dates'
import { formatArea, formatInteger } from '../../lib/format'
import { useCrop, useUpdateCrop } from './api'
import { ColorDot, StatusBadge } from './CropBadges'
import { CropForm } from './CropForm'
import { DeleteCropDialog } from './DeleteCropDialog'
import { cropToForm } from './cropValidation'
import { colorLabel, cropDescription, cropStatus, type Crop } from './model'
import styles from './CropDetailPage.module.css'

export function CropDetailPage() {
  const { cropId = '' } = useParams()
  const { data: crop, isPending, error } = useCrop(cropId)

  return (
    <div className={styles.page}>
      <Link to="/settings" className={styles.back}>
        ← Varieties
      </Link>
      {isPending ? (
        <LoadingState />
      ) : error ? (
        <ErrorState error={error} />
      ) : !crop ? (
        <EmptyState title="Variety not found" description="It may belong to a different greenhouse, or the link is incorrect." />
      ) : (
        <CropDetail key={crop.id} crop={crop} />
      )}
    </div>
  )
}

function CropDetail({ crop }: { crop: Crop }) {
  const [editing, setEditing] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const update = useUpdateCrop(crop.id)
  const status = cropStatus(crop)

  const deleteDialog = <DeleteCropDialog crop={crop} open={deleting} onClose={() => setDeleting(false)} />

  if (editing) {
    return (
      <>
        <section className={styles.panel}>
          <h1 className={styles.editTitle}>Edit {crop.name}</h1>
          <CropForm
            initialValues={cropToForm(crop)}
            submitLabel="Save changes"
            submitting={update.isPending}
            serverError={update.error?.message}
            onSubmit={(input) => update.mutate(input, { onSuccess: () => setEditing(false) })}
            onCancel={() => {
              update.reset()
              setEditing(false)
            }}
          />
        </section>
        <section className={`${styles.panel} ${styles.dangerZone}`}>
          <div>
            <h2 className={styles.sectionTitle}>Delete variety</h2>
            <p className={styles.dangerText}>Permanently remove this crop record.</p>
          </div>
          <button type="button" className="button button-danger-outline" onClick={() => setDeleting(true)} disabled={update.isPending}>
            Delete…
          </button>
        </section>
        {deleteDialog}
      </>
    )
  }

  return (
    <>
      <header className={styles.header}>
        <div className={styles.identity}>
          <ColorDot color={crop.color} />
          <div>
            <h1 className={styles.name}>{crop.name}</h1>
            <p className={styles.description}>
              {cropDescription(crop.color)} · planted {crop.planting_date.slice(0, 4)}
            </p>
          </div>
        </div>
        <div className={styles.headerActions}>
          <StatusBadge status={status} />
          <button type="button" className="button button-secondary" onClick={() => setEditing(true)}>
            Edit
          </button>
          <button type="button" className="button button-danger-outline" onClick={() => setDeleting(true)}>
            Delete
          </button>
        </div>
      </header>

      <section className={styles.stats}>
        <Stat label="Growing area" value={formatArea(crop.area_m2)} unit="m²" />
        <Stat label="Picking stems" value={formatInteger(crop.picking_stems)} />
        <Stat label="Stem density" value={(crop.picking_stems / crop.area_m2).toFixed(2)} unit="stems/m²" />
      </section>

      <section className={styles.panel}>
        <h2 className={styles.sectionTitle}>Season</h2>
        <SeasonProgress crop={crop} />
        <dl className={styles.details}>
          <Detail label="Planting date" value={formatDateLong(crop.planting_date)} />
          <Detail label="Pullout date" value={formatDateLong(crop.pullout_date)} />
          <Detail label="Season length" value={`${formatInteger(daysBetween(crop.planting_date, crop.pullout_date))} days`} />
        </dl>
      </section>

      <section className={styles.panel}>
        <h2 className={styles.sectionTitle}>Details</h2>
        <dl className={styles.details}>
          <Detail label="Variety name" value={crop.name} />
          <Detail label="Color" value={colorLabel(crop.color)} />
          <Detail label="Created" value={new Date(crop.created_at).toLocaleString()} />
          <Detail label="Last updated" value={new Date(crop.updated_at).toLocaleString()} />
        </dl>
      </section>
      {deleteDialog}
    </>
  )
}

function SeasonProgress({ crop }: { crop: Crop }) {
  const today = todayIso()
  const total = daysBetween(crop.planting_date, crop.pullout_date)
  const elapsed = Math.min(Math.max(daysBetween(crop.planting_date, today), 0), total)
  const status = cropStatus(crop, today)

  const label =
    status === 'planned'
      ? `Starts in ${formatInteger(daysBetween(today, crop.planting_date))} days`
      : status === 'finished'
        ? 'Season complete'
        : `Day ${formatInteger(elapsed + 1)} of ${formatInteger(total)} · ${formatInteger(total - elapsed)} days to pullout`

  return (
    <div className={styles.progress}>
      <div className={styles.progressTrack} role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={elapsed}>
        <div className={styles.progressFill} style={{ width: `${(elapsed / total) * 100}%` }} />
      </div>
      <p className={styles.progressLabel}>{label}</p>
    </div>
  )
}

function Stat({ label, value, unit }: { label: string; value: string; unit?: string }) {
  return (
    <div className={styles.stat}>
      <p className={styles.statLabel}>{label}</p>
      <p className={styles.statValue}>
        {value} {unit && <span className={styles.statUnit}>{unit}</span>}
      </p>
    </div>
  )
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className={styles.detail}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  )
}
