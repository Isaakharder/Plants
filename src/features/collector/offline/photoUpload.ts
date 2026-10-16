// Sends one queued Breaker photo: the image to the private Storage bucket,
// then its node_photos record. Both steps are safe to repeat:
//   * the object path contains the photo's own id and the bucket refuses to
//     overwrite, so a retry after a lost response finds "already exists" and
//     carries on;
//   * the record is inserted with ON CONFLICT (id) DO NOTHING.
// The record goes in only after the image is stored, so a record never
// points at a missing image.

import type { WriteResult } from './offlineQueue'

export const PHOTO_BUCKET = 'node-photos'

type StorageError = { message: string; status?: number; statusCode?: string | number } | null
export type PhotoUploader = {
  upload: (path: string, body: ArrayBuffer, contentType: string) => Promise<{ error: StorageError }>
  insertRecord: (record: Record<string, unknown>) => Promise<{ error: { message: string } | null; status: number }>
}

const isRetryable = (status: number) => status === 0 || status === 401 || status === 408 || status === 429 || status >= 500
const alreadyStored = (e: NonNullable<StorageError>) => String(e.statusCode) === '409' || /already exists|duplicate/i.test(e.message)

export async function sendPhoto(uploader: PhotoUploader, record: Record<string, unknown> & { storage_path: string; content_type: string }, image: Blob): Promise<WriteResult> {
  const stored = await uploader.upload(record.storage_path, await image.arrayBuffer(), record.content_type)
  if (stored.error && !alreadyStored(stored.error)) {
    const status = Number(stored.error.status ?? stored.error.statusCode ?? 0)
    const offline = typeof navigator !== 'undefined' && navigator.onLine === false
    return { ok: false, retryable: offline || isRetryable(status), message: `Photo upload: ${stored.error.message}` }
  }
  const saved = await uploader.insertRecord(record)
  if (saved.error) return { ok: false, retryable: isRetryable(saved.status), message: `Photo record: ${saved.error.message}` }
  return { ok: true }
}
