// Climate data: reads through row level security and the monitoring functions;
// writes only through owner-checked functions and the `climate` Edge Function.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { FunctionsHttpError } from '@supabase/supabase-js'
import { supabase } from '../../lib/supabase'
import type { ImportOutcome } from './importMessages'
import type {
  ClimateAgentKeyRow,
  ClimateDailySeries,
  ClimateFileReviewRow,
  ClimateFileState,
  ClimateImportAttemptRow,
  ClimateImportFileRow,
  ClimateImportStatus,
  ClimateReadingRow,
  ClimateSeries,
  ClimateSourceRow,
  ClimateZoneRow,
  CropClimateZoneRow,
} from '../../lib/database.types'

export const climateKeys = {
  all: ['climate'] as const,
  source: (orgId: string) => ['climate', 'source', orgId] as const,
  zones: (sourceId: string) => ['climate', 'zones', sourceId] as const,
  status: (sourceId: string) => ['climate', 'status', sourceId] as const,
  series: (...k: unknown[]) => ['climate', 'series', ...k] as const,
  files: (sourceId: string, filter: string) => ['climate', 'files', sourceId, filter] as const,
  attempts: (sourceId: string) => ['climate', 'attempts', sourceId] as const,
  file: (fileId: string) => ['climate', 'file', fileId] as const,
  keys: (sourceId: string) => ['climate', 'keys', sourceId] as const,
  cropZones: (cropId: string) => ['climate', 'cropZones', cropId] as const,
  zoneUse: (orgId: string) => ['climate', 'zoneUse', orgId] as const,
}

function check<T>(res: { data: T | null; error: { message: string } | null }): T {
  if (res.error) throw new Error(res.error.message)
  return res.data as T
}

/** The organization's climate source (one per organization today), or null before it's set up. */
export function useClimateSource(organizationId: string) {
  return useQuery({
    queryKey: climateKeys.source(organizationId),
    queryFn: async () =>
      check(await supabase.from('climate_sources').select('*').eq('organization_id', organizationId).order('created_at').limit(1).maybeSingle()) as ClimateSourceRow | null,
  })
}

export function useCreateClimateSource(organizationId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (name: string) => check(await supabase.rpc('climate_create_source', { p_organization_id: organizationId, p_name: name })),
    onSuccess: () => qc.invalidateQueries({ queryKey: climateKeys.source(organizationId) }),
  })
}

export function useClimateZones(sourceId: string | undefined) {
  return useQuery({
    queryKey: climateKeys.zones(sourceId ?? ''),
    enabled: Boolean(sourceId),
    queryFn: async () => check(await supabase.from('climate_zones').select('*').eq('source_id', sourceId!).order('zone_number', { nullsFirst: false })) as ClimateZoneRow[],
  })
}

export function useRenameZone(sourceId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ zoneId, name }: { zoneId: string; name: string }) => check(await supabase.rpc('climate_set_zone_display_name', { p_zone_id: zoneId, p_display_name: name })),
    onSuccess: () => qc.invalidateQueries({ queryKey: climateKeys.zones(sourceId) }),
  })
}

export function useImportStatus(sourceId: string | undefined) {
  return useQuery({
    queryKey: climateKeys.status(sourceId ?? ''),
    enabled: Boolean(sourceId),
    refetchInterval: 5 * 60_000,
    queryFn: async () => check(await supabase.rpc('climate_import_status', { p_source_id: sourceId! })) as ClimateImportStatus,
  })
}

export function useSeries(sourceId: string | undefined, zoneIds: string[], metrics: string[], from: string, to: string) {
  return useQuery({
    queryKey: climateKeys.series('zones', sourceId, zoneIds, metrics, from, to),
    enabled: Boolean(sourceId) && zoneIds.length > 0,
    queryFn: async () =>
      check(await supabase.rpc('climate_series', { p_source_id: sourceId!, p_zone_ids: zoneIds, p_metrics: metrics, p_from: from, p_to: to })) as ClimateSeries[],
  })
}

export function useCropSeries(cropId: string | undefined, metrics: string[], from: string, to: string) {
  return useQuery({
    queryKey: climateKeys.series('crop', cropId, metrics, from, to),
    enabled: Boolean(cropId),
    queryFn: async () => check(await supabase.rpc('crop_climate_series', { p_crop_id: cropId!, p_metrics: metrics, p_from: from, p_to: to })) as ClimateSeries[],
  })
}

export function useDaily(sourceId: string | undefined, zoneIds: string[], metrics: string[], fromDate: string, toDate: string, enabled = true) {
  return useQuery({
    queryKey: climateKeys.series('daily', sourceId, zoneIds, metrics, fromDate, toDate),
    enabled: enabled && Boolean(sourceId) && zoneIds.length > 0,
    queryFn: async () =>
      check(await supabase.rpc('climate_daily', { p_source_id: sourceId!, p_zone_ids: zoneIds, p_metrics: metrics, p_from: fromDate, p_to: toDate })) as ClimateDailySeries[],
  })
}

export function useMissingHours(sourceId: string | undefined, from: string, to: string) {
  return useQuery({
    queryKey: climateKeys.series('missing', sourceId, from, to),
    enabled: Boolean(sourceId),
    queryFn: async () => check(await supabase.rpc('climate_missing_hours', { p_source_id: sourceId!, p_from: from, p_to: to })) as [string, string, number][],
  })
}

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

/** File columns for lists (never the bytes). */
const FILE_COLUMNS =
  'id, organization_id, source_id, sha256, byte_size, original_filename, encoding, channel, agent_version, received_at, parser_version, parse_status, problems, warnings, filename_local, system_date_raw, system_time_raw, week_number_raw, hour_utc, hour_local, time_method, date_order, clock_offset_minutes, hour_state, reviewed_at, reviewed_by, review_note'

export type ClimateFile = Omit<ClimateImportFileRow, 'raw_bytes' | 'metadata' | 'agent_key_id' | 'uploaded_by'>

export type FileFilter = 'all' | ClimateFileState | 'review'
export const PAGE = 50

export function useImportFiles(sourceId: string | undefined, filter: FileFilter, limit: number) {
  return useQuery({
    queryKey: [...climateKeys.files(sourceId ?? '', filter), limit],
    enabled: Boolean(sourceId),
    queryFn: async () => {
      let q = supabase.from('climate_import_files').select(FILE_COLUMNS).eq('source_id', sourceId!)
      if (filter === 'review') q = q.in('hour_state', ['conflict', 'none'])
      else if (filter !== 'all') q = q.eq('hour_state', filter)
      return check(await q.order('received_at', { ascending: false }).order('id').limit(limit)) as unknown as ClimateFile[]
    },
  })
}

export function useImportAttempts(sourceId: string | undefined) {
  return useQuery({
    queryKey: climateKeys.attempts(sourceId ?? ''),
    enabled: Boolean(sourceId),
    queryFn: async () =>
      check(await supabase.from('climate_import_attempts').select('*').eq('source_id', sourceId!).order('created_at', { ascending: false }).order('id', { ascending: false }).limit(50)) as ClimateImportAttemptRow[],
  })
}

export type FileDetail = {
  file: ClimateFile
  readings: ClimateReadingRow[]
  reviews: ClimateFileReviewRow[]
  /** The file in effect for the same hour, when this one isn't. */
  active: { file: ClimateFile; readings: ClimateReadingRow[] } | null
}

export function useFileDetail(fileId: string | null) {
  return useQuery({
    queryKey: climateKeys.file(fileId ?? ''),
    enabled: Boolean(fileId),
    queryFn: async (): Promise<FileDetail> => {
      const file = check(await supabase.from('climate_import_files').select(FILE_COLUMNS).eq('id', fileId!).single()) as unknown as ClimateFile
      const [readings, reviews] = await Promise.all([
        supabase.from('climate_readings').select('*').eq('file_id', file.id).order('id').then(check),
        supabase.from('climate_file_reviews').select('*').eq('file_id', file.id).order('id').then(check),
      ])
      let active: FileDetail['active'] = null
      if (file.hour_state !== 'active' && file.hour_utc) {
        const other = check(
          await supabase.from('climate_import_files').select(FILE_COLUMNS).eq('source_id', file.source_id).eq('hour_utc', file.hour_utc).eq('hour_state', 'active').maybeSingle(),
        ) as unknown as ClimateFile | null
        if (other) active = { file: other, readings: check(await supabase.from('climate_readings').select('*').eq('file_id', other.id).order('id')) as ClimateReadingRow[] }
      }
      return { file, readings: readings as ClimateReadingRow[], reviews: reviews as ClimateFileReviewRow[], active }
    },
  })
}

/** The original file's bytes, exactly as received. */
export async function downloadOriginal(fileId: string): Promise<{ name: string; bytes: Uint8Array }> {
  const row = check(await supabase.from('climate_import_files').select('original_filename, raw_bytes').eq('id', fileId).single()) as Pick<
    ClimateImportFileRow,
    'original_filename' | 'raw_bytes'
  > | null
  if (!row) throw new Error('File not found')
  const hex = String(row.raw_bytes).replace(/^\\x/, '')
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16)
  return { name: row.original_filename, bytes }
}

async function functionError(error: unknown): Promise<Error> {
  if (error instanceof FunctionsHttpError) {
    try {
      const body = await error.context.json()
      return new Error(body.message ?? body.error ?? 'Request failed')
    } catch {
      return new Error(`Request failed (${error.context.status})`)
    }
  }
  return error instanceof Error ? error : new Error(String(error))
}

export type ManualResult = ImportOutcome & { filename: string }

/** Uploads files to the Edge Function in batches; every file is stored or reported on its own. */
export async function uploadClimateFiles(sourceId: string, files: File[], onBatch: (results: ManualResult[]) => void): Promise<void> {
  const BATCH = 20
  for (let i = 0; i < files.length; i += BATCH) {
    const batch = files.slice(i, i + BATCH)
    const form = new FormData()
    form.set('source_id', sourceId)
    for (const f of batch) form.append('files', f, f.name)
    const { data, error } = await supabase.functions.invoke('climate/manual', { body: form })
    if (error) {
      const e = await functionError(error)
      onBatch(batch.map((f) => ({ filename: f.name, status: 'error', message: e.message })))
      continue
    }
    onBatch((data as { results: ManualResult[] }).results)
  }
}

export function useInvalidateClimate() {
  const qc = useQueryClient()
  return () => qc.invalidateQueries({ queryKey: climateKeys.all })
}

export function useReviewFile() {
  const invalidate = useInvalidateClimate()
  return useMutation({
    mutationFn: async (a: { fileId: string; action: 'activate' | 'set_aside'; note: string }) =>
      check(await supabase.rpc('climate_review_file', { p_file_id: a.fileId, p_action: a.action, p_note: a.note })),
    onSuccess: invalidate,
  })
}

export function useResolveQuarantine() {
  const invalidate = useInvalidateClimate()
  return useMutation({
    mutationFn: async (a: { fileId: string; hourUtc: string; note: string }) => {
      const { data, error } = await supabase.functions.invoke('climate/review', { body: { file_id: a.fileId, hour_utc: a.hourUtc, note: a.note } })
      if (error) throw await functionError(error)
      return data as { state: string; readings: number; hour_local: string }
    },
    onSuccess: invalidate,
  })
}

// ---------------------------------------------------------------------------
// Agent keys
// ---------------------------------------------------------------------------

export function useAgentKeys(sourceId: string | undefined) {
  return useQuery({
    queryKey: climateKeys.keys(sourceId ?? ''),
    enabled: Boolean(sourceId),
    queryFn: async () =>
      check(
        await supabase
          .from('climate_agent_keys')
          .select('id, organization_id, source_id, label, key_prefix, created_at, created_by, expires_at, revoked_at, revoked_by, last_used_at')
          .eq('source_id', sourceId!)
          .order('created_at', { ascending: false }),
      ) as ClimateAgentKeyRow[],
  })
}

export function useCreateAgentKey(sourceId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (a: { label: string; expiresAt: string | null }) =>
      check(await supabase.rpc('climate_create_agent_key', { p_source_id: sourceId, p_label: a.label, p_expires_at: a.expiresAt })),
    onSuccess: () => qc.invalidateQueries({ queryKey: climateKeys.keys(sourceId) }),
  })
}

export function useRevokeAgentKey(sourceId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (keyId: string) => check(await supabase.rpc('climate_revoke_agent_key', { p_key_id: keyId })),
    onSuccess: () => qc.invalidateQueries({ queryKey: climateKeys.keys(sourceId) }),
  })
}

/** The address the agent's "Server URL" points at. */
export const agentServerUrl = `${import.meta.env.VITE_SUPABASE_URL ?? ''}/functions/v1/climate`

// ---------------------------------------------------------------------------
// Planting ↔ zones
// ---------------------------------------------------------------------------

export function useCropClimateZones(cropId: string | undefined) {
  return useQuery({
    queryKey: climateKeys.cropZones(cropId ?? ''),
    enabled: Boolean(cropId),
    queryFn: async () =>
      check(await supabase.from('crop_climate_zones').select('*').eq('crop_id', cropId!).order('valid_from').order('recorded_at')) as CropClimateZoneRow[],
  })
}

/** Current assignments of every planting, for "used by" in Settings. */
export function useZoneUse(organizationId: string) {
  return useQuery({
    queryKey: climateKeys.zoneUse(organizationId),
    queryFn: async () =>
      check(
        await supabase.from('crop_climate_zones').select('crop_id, zone_id, valid_from, valid_until, area_share').eq('organization_id', organizationId).is('superseded_at', null),
      ) as Pick<CropClimateZoneRow, 'crop_id' | 'zone_id' | 'valid_from' | 'valid_until' | 'area_share'>[],
  })
}

export function useSetCropClimateZones(cropId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (a: { from: string; zones: { zone_id: string; area_share: number | null }[]; reason: string }) =>
      check(await supabase.rpc('set_crop_climate_zones', { p_crop_id: cropId, p_from: a.from, p_zones: a.zones, p_reason: a.reason || null })),
    onSuccess: () => qc.invalidateQueries({ queryKey: climateKeys.all }),
  })
}
