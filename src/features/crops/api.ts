import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '../../lib/supabase'
import type { PepperTypeRow } from '../../lib/database.types'
import type { Crop } from './model'
import type { CropInput } from './cropValidation'

const cropKeys = {
  all: ['crops'] as const,
  lists: ['crops', 'list'] as const,
  list: (organizationId: string) => ['crops', 'list', organizationId] as const,
  detail: (id: string) => ['crops', 'detail', id] as const,
}

const num = (v: number | null) => (v === null ? null : Number(v))
const normalize = (crop: Crop): Crop => ({
  ...crop,
  area_m2: Number(crop.area_m2),
  sets_provisional_survival: num(crop.sets_provisional_survival),
  sets_provisional_timing: crop.sets_provisional_timing?.map(Number) ?? null,
})

export type PepperType = PepperTypeRow

const normalizeType = (t: PepperTypeRow): PepperType => ({
  ...t,
  provisional_survival: num(t.provisional_survival),
  provisional_timing: t.provisional_timing?.map(Number) ?? null,
  default_afw_g: num(t.default_afw_g),
})

/** The organization's pepper types (forecasting model groups), by name. */
export function usePepperTypes(organizationId: string) {
  return useQuery({
    queryKey: ['crops', 'pepperTypes', organizationId] as const,
    queryFn: async () => {
      const { data, error } = await supabase.from('pepper_types').select('*').eq('organization_id', organizationId).order('name')
      if (error) throw error
      return data.map(normalizeType)
    },
  })
}

export type PepperTypeChange = Partial<Pick<PepperType, 'provisional_survival' | 'provisional_timing' | 'default_afw_g' | 'pool_within_type'>>

/** Owners change a pepper type's provisional assumptions (RLS refuses others). */
export function useUpdatePepperType(organizationId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ id, change }: { id: string; change: PepperTypeChange }) => {
      const { data, error } = await supabase.from('pepper_types').update(change).eq('id', id).select('id')
      if (error) throw error
      if (data.length === 0) throw new Error('Only owners can change pepper type assumptions.')
    },
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: ['crops', 'pepperTypes', organizationId] }),
        queryClient.invalidateQueries({ queryKey: ['forecast', 'setsPotential'] }),
      ]),
  })
}

export function useCrops(organizationId: string) {
  return useQuery({
    queryKey: cropKeys.list(organizationId),
    queryFn: async () => {
      const { data, error } = await supabase
        .from('crops')
        .select('*')
        .eq('organization_id', organizationId)
        .order('planting_date', { ascending: false })
      if (error) throw error
      return data.map(normalize)
    },
  })
}

export function useCrop(id: string) {
  return useQuery({
    queryKey: cropKeys.detail(id),
    queryFn: async () => {
      const { data, error } = await supabase.from('crops').select('*').eq('id', id).maybeSingle()
      if (error) throw error
      return data ? normalize(data) : null
    },
  })
}

export function useCreateCrop(organizationId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: CropInput) => {
      const { data, error } = await supabase
        .from('crops')
        .insert({ ...input, organization_id: organizationId })
        .select()
        .single()
      if (error) throw error
      return normalize(data)
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: cropKeys.all }),
  })
}

export function useUpdateCrop(id: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: CropInput) => {
      const { data, error } = await supabase.from('crops').update(input).eq('id', id).select().single()
      if (error) throw error
      return normalize(data)
    },
    onSuccess: (crop) => {
      queryClient.setQueryData(cropKeys.detail(id), crop)
      return queryClient.invalidateQueries({ queryKey: cropKeys.all })
    },
  })
}

export function useDeleteCrop(id: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async () => {
      // .select() makes a silent RLS refusal (0 rows) surface as an error.
      const { data, error } = await supabase.from('crops').delete().eq('id', id).select('id')
      if (error) throw error
      if (data.length === 0) throw new Error('This variety could not be deleted. It may already have been removed.')
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: cropKeys.lists }),
  })
}

/** Call after navigating away from a deleted crop's page. */
export function useForgetCrop() {
  const queryClient = useQueryClient()
  return (id: string) => queryClient.removeQueries({ queryKey: cropKeys.detail(id) })
}
