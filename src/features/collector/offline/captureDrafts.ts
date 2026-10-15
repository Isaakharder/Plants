// Breaker photos taken but not saved yet, kept on the device. Phones can
// reload the page while the camera is open or the screen is locked; the
// photos already taken come back when the worker returns to that node.
// Drafts never reach the server: saving the Breaker turns them into queued
// uploads and deletes the draft.

import type { PhotoSide } from '../../../lib/database.types'
import type { PreparedPhoto } from '../photos'

export type CaptureDraft = {
  /** userId:nodeId */
  key: string
  userId: string
  nodeId: string
  stemId: string
  /** When the worker opened the photo step (for the capture time). */
  startedAt: number
  savedAt: number
  shots: Partial<Record<PhotoSide, PreparedPhoto>>
}

export interface DraftStorage {
  get(key: string): Promise<CaptureDraft | undefined>
  getAll(): Promise<CaptureDraft[]>
  put(draft: CaptureDraft): Promise<void>
  delete(key: string): Promise<void>
}

/** Drafts older than this are dropped (a forgotten capture from another day). */
export const DRAFT_MAX_AGE_MS = 12 * 60 * 60 * 1000

export const draftKey = (userId: string, nodeId: string) => `${userId}:${nodeId}`

const DB_NAME = 'plants-breaker-drafts'
const STORE = 'drafts'

export function indexedDbDrafts(): DraftStorage {
  let db: Promise<IDBDatabase> | null = null
  const open = () =>
    (db ??= new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1)
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: 'key' })
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    }))
  const run = async <T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> => {
    const tx = (await open()).transaction(STORE, mode, mode === 'readwrite' ? { durability: 'strict' } : undefined)
    const req = fn(tx.objectStore(STORE))
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve(req ? (req.result as T) : undefined)
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error ?? new Error('Draft write aborted'))
    })
  }
  return {
    get: (key) => run<CaptureDraft>('readonly', (s) => s.get(key)),
    getAll: async () => (await run<CaptureDraft[]>('readonly', (s) => s.getAll())) ?? [],
    put: async (draft) => void (await run('readwrite', (s) => void s.put(draft))),
    delete: async (key) => void (await run('readwrite', (s) => void s.delete(key))),
  }
}

export function memoryDrafts(): DraftStorage {
  const items = new Map<string, CaptureDraft>()
  return {
    get: async (key) => items.get(key),
    getAll: async () => [...items.values()],
    put: async (draft) => void items.set(draft.key, draft),
    delete: async (key) => void items.delete(key),
  }
}

let _drafts: DraftStorage | null = null
/** The device's draft store (IndexedDB); tests pass their own. */
export const captureDrafts = (): DraftStorage => (_drafts ??= typeof indexedDB === 'undefined' ? memoryDrafts() : indexedDbDrafts())

/** A user's drafts that are still fresh; stale ones are removed. */
export async function freshDrafts(storage: DraftStorage, userId: string, now = Date.now()): Promise<CaptureDraft[]> {
  const all = (await storage.getAll()).filter((d) => d.userId === userId)
  const stale = all.filter((d) => now - d.savedAt > DRAFT_MAX_AGE_MS)
  await Promise.all(stale.map((d) => storage.delete(d.key)))
  return all.filter((d) => !stale.includes(d) && Object.keys(d.shots).length > 0)
}
