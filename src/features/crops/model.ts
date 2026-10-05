import type { CropColor, Database } from '../../lib/database.types'
import { todayIso, type IsoDate } from '../../lib/dates'

export type Crop = Database['public']['Tables']['crops']['Row']
export type { CropColor }

export const CROP_COLORS: { value: CropColor; label: string }[] = [
  { value: 'red', label: 'Red' },
  { value: 'orange', label: 'Orange' },
  { value: 'yellow', label: 'Yellow' },
  { value: 'green', label: 'Green' },
  { value: 'other', label: 'Other' },
]

export const colorLabel = (color: CropColor) => CROP_COLORS.find((c) => c.value === color)?.label ?? color

/** "Red Bell Pepper", or "Bell Pepper" for Other. */
export const cropDescription = (color: CropColor) => (color === 'other' ? 'Bell Pepper' : `${colorLabel(color)} Bell Pepper`)

/**
 * Planting density, derived from the stored area and picking stems (never
 * stored, so it can't disagree with them). Both are > 0 in the database.
 */
export const stemsPerM2 = (crop: Pick<Crop, 'picking_stems' | 'area_m2'>) => crop.picking_stems / crop.area_m2

// Status is derived from dates, never stored, so it can't go stale.
export type CropStatus = 'planned' | 'active' | 'finished'

export function cropStatus(crop: Pick<Crop, 'planting_date' | 'pullout_date'>, today: IsoDate = todayIso()): CropStatus {
  if (today < crop.planting_date) return 'planned'
  if (today > crop.pullout_date) return 'finished'
  return 'active'
}

export const STATUS_LABELS: Record<CropStatus, string> = {
  planned: 'Planned',
  active: 'Active',
  finished: 'Finished',
}

const STATUS_ORDER: Record<CropStatus, number> = { active: 0, planned: 1, finished: 2 }

/** Active first, then planned, then finished; newest planting first within each. */
export function sortCrops(crops: Crop[]): Crop[] {
  const today = todayIso()
  return [...crops].sort(
    (a, b) =>
      STATUS_ORDER[cropStatus(a, today)] - STATUS_ORDER[cropStatus(b, today)] ||
      b.planting_date.localeCompare(a.planting_date) ||
      a.name.localeCompare(b.name),
  )
}
