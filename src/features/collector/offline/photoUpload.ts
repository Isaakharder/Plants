// Sends one queued Breaker photo: the original image and its preview to the
// private Storage bucket, then its node_photos record. Every step is safe to
// repeat:
//   * object paths contain the photo's own id and the bucket refuses to
//     overwrite, so a retry after a lost response finds "already exists" and
//     carries on;
//   * the record is inserted with ON CONFLICT (id) DO NOTHING.
// The record goes in only after the original is stored, so a record never
// points at a missing image. A preview that is refused (not just delayed) is
// dropped from the record rather than blocking the photo.

import type { WriteResult } from './offlineQueue'

export const PHOTO_BUCKET = 'node-photos'

type StorageError = { message: string; status?: number; statusCode?: string | number } | null
export type PhotoUploader = {
  upload: (path: string, body: ArrayBuffer, contentType: string) => Promise<{ error: StorageError }>
  insertRecord: (record: Record<string, unknown>) => Promise<{ error: { message: string } | null; status: number }>
}

type PhotoRecord = Record<string, unknown> & { storage_path: string; content_type: string; preview_path?: string | null }

const isRetryable = (status: number) => status === 0 || status === 401 || status === 408 || status === 429 || status >= 500
const alreadyStored = (e: NonNullable<StorageError>) => String(e.statusCode) === '409' || /already exists|duplicate/i.test(e.message)
const offline = () => typeof navigator !== 'undefined' && navigator.onLine === false

async function store(uploader: PhotoUploader, path: string, blob: Blob, contentType: string): Promise<'stored' | 'retry' | 'refused'> {
  const res = await uploader.upload(path, await blob.arrayBuffer(), contentType)
  if (!res.error || alreadyStored(res.error)) return 'stored'
  return offline() || isRetryable(Number(res.error.status ?? res.error.statusCode ?? 0)) ? 'retry' : 'refused'
}

export async function sendPhoto(uploader: PhotoUploader, record: PhotoRecord, image: Blob, preview: Blob | null = null): Promise<WriteResult> {
  const original = await store(uploader, record.storage_path, image, record.content_type)
  if (original !== 'stored') return { ok: false, retryable: original === 'retry', message: 'Photo upload failed' + (original === 'retry' ? ' (will retry)' : '') }

  let row = record
  if (record.preview_path) {
    const small = preview ? await store(uploader, record.preview_path, preview, 'image/jpeg') : 'refused'
    if (small === 'retry') return { ok: false, retryable: true, message: 'Photo preview upload failed (will retry)' }
    if (small === 'refused') row = { ...record, preview_path: null }
  }

  const saved = await uploader.insertRecord(row)
  if (saved.error) return { ok: false, retryable: isRetryable(saved.status), message: `Photo record: ${saved.error.message}` }
  return { ok: true }
}
