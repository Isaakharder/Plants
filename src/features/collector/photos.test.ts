import { describe, expect, it } from 'vitest'
import { photoContentType, photoPath, preparePhoto, previewPath, previewSize, sha256Hex } from './photos'

describe('Breaker photos on the device', () => {
  it('accepts camera images (a blank type is a JPEG capture) and nothing else', () => {
    expect(photoContentType(new Blob([], { type: 'image/jpeg' }))).toBe('image/jpeg')
    expect(photoContentType(new Blob([], { type: 'image/heic' }))).toBe('image/heic')
    expect(photoContentType(new Blob([]))).toBe('image/jpeg')
    expect(photoContentType(new Blob([], { type: 'application/pdf' }))).toBeNull()
  })

  it('stores each photo in its organization / crop / node folder under its own id', () => {
    expect(photoPath('org', 'crop', 'node', 'p1', 'image/jpeg')).toBe('org/crop/node/p1.jpg')
    expect(photoPath('org', 'crop', 'node', 'p1', 'image/heic')).toBe('org/crop/node/p1.heic')
    expect(previewPath('org', 'crop', 'node', 'p1')).toBe('org/crop/node/p1.preview.jpg')
  })

  it('makes previews at most 640 px on the long side, keeping the shape, never enlarging', () => {
    expect(previewSize(3024, 4032)).toEqual({ width: 480, height: 640 })
    expect(previewSize(4032, 3024)).toEqual({ width: 640, height: 480 })
    expect(previewSize(300, 200)).toEqual({ width: 300, height: 200 })
  })

  it('fingerprints the image bytes with SHA-256', async () => {
    expect(await sha256Hex(new TextEncoder().encode('abc').buffer as ArrayBuffer)).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })

  it('refuses non-images and empty files; keeps an image it can’t decode, without dimensions', async () => {
    await expect(preparePhoto('front', new Blob(['x'], { type: 'text/plain' }))).rejects.toThrow(/isn’t a photo/)
    await expect(preparePhoto('front', new Blob([], { type: 'image/jpeg' }))).rejects.toThrow(/empty/)
    const p = await preparePhoto('back', new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' }))
    expect(p).toMatchObject({ side: 'back', contentType: 'image/jpeg', bytes: 3, width: null, height: null, preview: null })
    expect(p.captureMeta).toMatchObject({ source: 'camera', collector: 'breaker-photos-1', guidance: 'centre-one-pepper-v1' })
    expect(p.sha256).toMatch(/^[0-9a-f]{64}$/)
  })
})
