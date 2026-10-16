// Breaker photos on the device: what is measured from a captured image before
// it is queued (size, type, SHA-256, dimensions) and where it will be stored.

import type { PhotoSide } from '../../lib/database.types'

const ALLOWED = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'])
const EXTENSION: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic', 'image/heif': 'heif' }
export const MAX_PHOTO_BYTES = 25_000_000

export type PreparedPhoto = { side: PhotoSide; image: Blob; contentType: string; bytes: number; sha256: string; width: number | null; height: number | null; takenAt: string }

/** The image's type, as stored (phones sometimes leave it blank for camera captures: JPEG). */
export function photoContentType(file: Blob): string | null {
  const type = (file.type || 'image/jpeg').toLowerCase()
  return ALLOWED.has(type) ? type : null
}

export async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** Reads a captured image: refuses non-images and oversized files; dimensions when the browser can decode it. */
export async function preparePhoto(side: PhotoSide, file: Blob): Promise<PreparedPhoto> {
  const contentType = photoContentType(file)
  if (!contentType) throw new Error('That file isn’t a photo (JPEG, PNG, WebP or HEIC).')
  if (file.size === 0) throw new Error('The photo is empty. Take it again.')
  if (file.size > MAX_PHOTO_BYTES) throw new Error('The photo is larger than 25 MB.')
  let width: number | null = null
  let height: number | null = null
  try {
    const bitmap = await createImageBitmap(file)
    width = bitmap.width
    height = bitmap.height
    bitmap.close()
  } catch {
    // Not decodable here (e.g. HEIC in some browsers): stored without dimensions.
  }
  return { side, image: file, contentType, bytes: file.size, sha256: await sha256Hex(await file.arrayBuffer()), width, height, takenAt: new Date().toISOString() }
}

/** <organization>/<crop>/<node>/<photo id>.<ext>: the bucket's folder rules key on the first segment. */
export const photoPath = (organizationId: string, cropId: string, nodeId: string, photoId: string, contentType: string) =>
  `${organizationId}/${cropId}/${nodeId}/${photoId}.${EXTENSION[contentType] ?? 'jpg'}`
