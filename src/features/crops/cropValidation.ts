import { z } from 'zod'
import { isIsoDate } from '../../lib/dates'
import { formatArea, parseNumberInput } from '../../lib/format'
import type { Crop, CropColor } from './model'
import { formatTiming, parsePercent, parseTiming } from './pepperTypes'

/** Raw form state: everything is a string while the user types. */
export type CropFormValues = {
  name: string
  color: CropColor | ''
  planting_date: string
  pullout_date: string
  area_m2: string
  picking_stems: string
  /** The variety's pepper type (forecasting model group); required, never defaulted. */
  pepper_type_id: string
  /** Optional Sets outlook overrides; empty inherits the pepper type's assumptions. */
  sets_provisional_survival: string
  sets_provisional_timing: string
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
  pepper_type_id: '',
  sets_provisional_survival: '',
  sets_provisional_timing: '',
}

export function cropToForm(crop: Crop): CropFormValues {
  return {
    name: crop.name,
    color: crop.color,
    planting_date: crop.planting_date,
    pullout_date: crop.pullout_date,
    area_m2: formatArea(Number(crop.area_m2)),
    picking_stems: String(crop.picking_stems),
    pepper_type_id: crop.pepper_type_id,
    sets_provisional_survival: crop.sets_provisional_survival === null ? '' : String(Math.round(crop.sets_provisional_survival * 1000) / 10),
    sets_provisional_timing: formatTiming(crop.sets_provisional_timing),
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
    pepper_type_id: z.string().min(1, 'Choose a pepper type'),
    // Optional overrides: empty → null (the pepper type's value applies).
    sets_provisional_survival: z.string().transform((text, ctx) => {
      const r = parsePercent(text)
      if ('error' in r) {
        ctx.addIssue({ code: 'custom', message: r.error })
        return z.NEVER
      }
      return r.value
    }),
    sets_provisional_timing: z.string().transform((text, ctx) => {
      const r = parseTiming(text)
      if ('error' in r) {
        ctx.addIssue({ code: 'custom', message: r.error })
        return z.NEVER
      }
      return r.shares
    }),
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
