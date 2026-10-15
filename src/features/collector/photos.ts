// Breaker photos on the device: what is measured from a captured image before
// it is queued (size, type, SHA-256, dimensions), the small preview made from
// it, how it was captured, and where it will be stored.
//
// The original is kept byte for byte (full resolution). The preview is a
// ~640 px JPEG for the desktop viewer; when the phone can't decode the image
// (e.g. HEIC in some browsers) there is no preview and the viewer opens the
// original instead.

import type { PhotoSide } from '../../lib/database.types'

const ALLOWED = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'])
const EXTENSION: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic', 'image/heif': 'heif' }
export const MAX_PHOTO_BYTES = 25_000_000
export const PREVIEW_MAX_PX = 640
/** Recorded with every photo, to tell which collector version captured it. */
export const COLLECTOR_RELEASE = 'breaker-photos-1'

/**
 * The framing guidance shown on the photo step (approved 2026-10-15). Its
 * version is recorded with every photo, so analyses can tell photos taken
 * with it from earlier ones.
 *
 * Convention for colour analysis: the target pepper is the CENTRED fruit.
 * Centring alone does not guarantee the right fruit is identified:
 * neighbouring peppers can overlap the target, so analysis must segment the
 * target pepper from the fruit around it (e.g. a segmentation prompted at the
 * image centre), never simply measure the centre of the frame.
 */
export const PHOTO_GUIDANCE = 'Centre ONE pepper in the photo. Keep the whole pepper visible. Move leaves aside and avoid other peppers, hands and people in the background.'
export const PHOTO_GUIDANCE_VERSION = 'centre-one-pepper-v1'

/**
 * Camera-first Breaker recording is on unless the build sets
 * VITE_BREAKER_PHOTOS=off. Turning it off only hides the camera step (Breaker
 * is then recorded without photos, as before); photos already waiting on a
 * phone still upload. This, not going back to an older build, is the safe
 * way to switch the feature off.
 */
export const BREAKER_PHOTOS_ENABLED = import.meta.env.VITE_BREAKER_PHOTOS !== 'off'

/** Asks the browser to keep the collector's stored data (queued photos) under storage pressure. Best effort. */
export function requestPersistentStorage(): void {
  try {
    void navigator.storage?.persist?.().catch(() => {})
  } catch {
    // Not supported: nothing to do.
  }
}

export type PreparedPhoto = {
  side: PhotoSide
  image: Blob
  preview: Blob | null
  contentType: string
  bytes: number
  sha256: string
  width: number | null
  height: number | null
  takenAt: string
  captureMeta: Record<string, string | number | null>
}

/** The image's type, as stored (phones sometimes leave it blank for camera captures: JPEG). */
export function photoContentType(file: Blob): string | null {
  const type = (file.type || 'image/jpeg').toLowerCase()
  return ALLOWED.has(type) ? type : null
}

export async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** Preview size keeping the aspect ratio, never enlarged. */
export function previewSize(width: number, height: number, max = PREVIEW_MAX_PX): { width: number; height: number } {
  const scale = Math.min(1, max / Math.max(width, height))
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }
}

async function encodePreview(bitmap: ImageBitmap): Promise<Blob | null> {
  const { width, height } = previewSize(bitmap.width, bitmap.height)
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(width, height)
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0, width, height)
    return canvas.convertToBlob({ type: 'image/jpeg', quality: 0.75 })
  }
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, width, height)
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.75))
}

/** Reads a captured image: refuses non-images and oversized files; dimensions and a preview when the browser can decode it. */
export async function preparePhoto(side: PhotoSide, file: Blob): Promise<PreparedPhoto> {
  const contentType = photoContentType(file)
  if (!contentType) throw new Error('That file isn’t a photo (JPEG, PNG, WebP or HEIC).')
  if (file.size === 0) throw new Error('The photo is empty. Take it again.')
  if (file.size > MAX_PHOTO_BYTES) throw new Error('The photo is larger than 25 MB.')
  let width: number | null = null
  let height: number | null = null
  let preview: Blob | null = null
  try {
    // Decodes with the photo's EXIF orientation applied, as it is displayed.
    const bitmap = await createImageBitmap(file)
    width = bitmap.width
    height = bitmap.height
    try {
      preview = await encodePreview(bitmap)
    } finally {
      bitmap.close()
    }
  } catch {
    // Not decodable here: stored without dimensions or preview.
  }
  const named = file as Partial<File>
  return {
    side,
    image: file,
    preview,
    contentType,
    bytes: file.size,
    sha256: await sha256Hex(await file.arrayBuffer()),
    width,
    height,
    takenAt: new Date().toISOString(),
    captureMeta: {
      source: 'camera',
      collector: COLLECTOR_RELEASE,
      guidance: PHOTO_GUIDANCE_VERSION,
      userAgent: typeof navigator === 'undefined' ? null : navigator.userAgent.slice(0, 200),
      fileName: named.name ? named.name.slice(0, 120) : null,
      fileLastModified: named.lastModified ? new Date(named.lastModified).toISOString() : null,
    },
  }
}

/** <organization>/<crop>/<node>/<photo id>.<ext>: the bucket's folder rules key on the first segment. */
export const photoPath = (organizationId: string, cropId: string, nodeId: string, photoId: string, contentType: string) =>
  `${organizationId}/${cropId}/${nodeId}/${photoId}.${EXTENSION[contentType] ?? 'jpg'}`

/** The preview's path, next to its original. */
export const previewPath = (organizationId: string, cropId: string, nodeId: string, photoId: string) => `${organizationId}/${cropId}/${nodeId}/${photoId}.preview.jpg`
