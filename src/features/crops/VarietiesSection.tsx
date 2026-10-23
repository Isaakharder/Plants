import { useState } from 'react'
import { EmptyState, ErrorState, LoadingState } from '../../components/States'
import { useOrganization } from '../organization/OrganizationProvider'
import { useCrops, usePepperTypes } from './api'
import { CropCard } from './CropCard'
import { CreateCropDialog } from './CreateCropDialog'
import { cropStatus, sortCrops, type Crop } from './model'
import styles from './VarietiesSection.module.css'

export function VarietiesSection() {
  const organization = useOrganization()
  const { data: crops, isPending, error } = useCrops(organization.id)
  const pepperTypes = usePepperTypes(organization.id)
  const typeName = (crop: Crop) => pepperTypes.data?.find((t) => t.id === crop.pepper_type_id)?.name ?? null
  const [creating, setCreating] = useState(false)

  const createButton = (
    <button type="button" className="button button-primary" onClick={() => setCreating(true)}>
      + Create variety
    </button>
  )

  const sorted = sortCrops(crops ?? [])
  const current = sorted.filter((c) => cropStatus(c) !== 'finished')
  const finished = sorted.filter((c) => cropStatus(c) === 'finished')

  return (
    <section className={styles.section} aria-labelledby="varieties-heading">
      <div className={styles.header}>
        <div>
          <h2 id="varieties-heading" className={styles.title}>Varieties</h2>
          <p className={styles.description}>The pepper crops growing in your greenhouse. Each planting is its own record.</p>
        </div>
        {crops && crops.length > 0 && createButton}
      </div>

      {isPending ? (
        <LoadingState />
      ) : error ? (
        <ErrorState error={error} />
      ) : sorted.length === 0 ? (
        <EmptyState
          title="No varieties yet"
          description="Add the first crop you're growing — its name, color, dates, area and picking stems."
          action={createButton}
        />
      ) : (
        <>
          <CropGrid crops={current} typeName={typeName} />
          {finished.length > 0 && (
            <div className={styles.group}>
              <h3 className={styles.groupTitle}>Finished</h3>
              <CropGrid crops={finished} typeName={typeName} />
            </div>
          )}
        </>
      )}

      <CreateCropDialog open={creating} onClose={() => setCreating(false)} />
    </section>
  )
}

function CropGrid({ crops, typeName }: { crops: Crop[]; typeName: (crop: Crop) => string | null }) {
  if (crops.length === 0) return null
  return (
    <div className={styles.grid}>
      {crops.map((crop) => (
        <CropCard key={crop.id} crop={crop} pepperType={typeName(crop)} />
      ))}
    </div>
  )
}
