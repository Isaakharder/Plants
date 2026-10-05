import type { CropColor } from '../../lib/database.types'

/** CropLink stored a hex colour per variety; Plants crops have a colour name. */
export const cropColorVar = (color: CropColor) => `var(--pepper-${color})`

/** Passed from the home page to the row canvas for an instant header. */
export interface CanvasState {
  rowName: string
  varietyId: string
  varietyName: string
  varietyColor: string | null
}
