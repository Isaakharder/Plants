import { z } from 'zod'
import { isIsoDate } from '../../lib/dates'
import { formatArea, parseNumberInput } from '../../lib/format'
import type { Crop, CropColor } from './model'

/** Raw form state: everything is a string while the user types. */
export type CropFormValues = {
  name: string
  color: CropColor | ''
  planting_date: string
  pullout_date: string
  area_m2: string
  picking_stems: string
}

export type CropFormField = keyof CropFormValues
export type CropFormErrors = Partial<Record<CropFormField, string>>

export const emptyCropForm: CropFormValues = {
  name: '',
  color: '',
  planting_date: '',
  pullout_date: '',
  area_m2: '',
  picking_stems: '',
}

export function cropToForm(crop: Crop): CropFormValues {
  return {
    name: crop.name,
    color: crop.color,
    planting_date: crop.planting_date,
    pullout_date: crop.pullout_date,
    area_m2: formatArea(Number(crop.area_m2)),
    picking_stems: String(crop.picking_stems),
  }
}

const numberField = (label: string, { integer }: { integer: boolean }) =>
  z
    .string()
    .trim()
    .min(1, `${label} is required`)
    .transform(parseNumberInput)
    .pipe(
      z
        .number({ error: `${label} must be a number` })
        .refine((n) => !Number.isNaN(n), `${label} must be a number`)
        .refine((n) => n > 0, `${label} must be greater than 0`)
        .refine((n) => !integer || Number.isInteger(n), `${label} must be a whole number`)
        .refine((n) => n < (integer ? 2_147_483_647 : 1e10), `${label} is too large`),
    )

const dateField = (label: string) =>
  z.string().min(1, `${label} is required`).refine(isIsoDate, `${label} is not a valid date`)

const cropSchema = z
  .object({
    name: z.string().trim().min(1, 'Variety name is required').max(100, 'Keep the name under 100 characters'),
    color: z.enum(['red', 'orange', 'yellow', 'green', 'other'], { error: 'Choose a color' }),
    planting_date: dateField('Planting date'),
    pullout_date: dateField('Pullout date'),
    area_m2: numberField('Growing area', { integer: false }),
    picking_stems: numberField('Picking stems', { integer: true }),
  })
  .refine((v) => v.pullout_date > v.planting_date, {
    path: ['pullout_date'],
    message: 'Pullout date must be after the planting date',
  })

export type CropInput = z.output<typeof cropSchema>

export function validateCropForm(values: CropFormValues): { data: CropInput } | { errors: CropFormErrors } {
  const result = cropSchema.safeParse(values)
  if (result.success) return { data: result.data }
  const errors: CropFormErrors = {}
  for (const issue of result.error.issues) {
    const field = issue.path[0] as CropFormField
    errors[field] ??= issue.message
  }
  return { errors }
}
