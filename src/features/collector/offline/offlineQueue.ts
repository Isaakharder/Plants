// Durable outbox for every collector write, backed by IndexedDB.
//
// Adapted from CropLink's offlineQueue.ts. Differences:
//   * Every write goes through the queue, online or not, so a measurement is on
//     the device before any network request is made and is never lost to a
//     failed or interrupted request.
//   * Records carry IDs generated on the device (see ids.ts), so there are no
//     temp IDs to remap and replaying a write after a lost response is a no-op.
//   * Each entry remembers the user who made it and is only replayed under that
//     user's session; organization_id is inside the record itself.
//   * Vegetative growth and node deactivation are queued too.

import type { Database } from '../../../lib/database.types'

type Insert<T extends keyof Database['public']['Tables']> = Database['public']['Tables'][T]['Insert']

export type QueuedWrite =
  | { type: 'create_row'; record: Insert<'measurement_rows'> }
  | { type: 'create_stem'; record: Insert<'measurement_stems'> }
  | { type: 'create_node'; record: Insert<'plant_nodes'> }
  | { type: 'deactivate_node'; record: { id: string; organization_id: string; measurement_stem_id: string } }
  | { type: 'record_status'; record: Insert<'node_observations'> }
  | { type: 'upsert_growth'; record: Insert<'stem_growth_measurements'> }

export type QueuedAction = QueuedWrite & {
  id: string
  userId: string
  status: 'pending' | 'failed'
  error: string | null
  attempts: number
  createdAt: number
}

/** Outcome of sending one write to the database. */
export type WriteResult = { ok: true } | { ok: false; retryable: boolean; message: string }
export type WriteExecutor = (write: QueuedWrite) => Promise<WriteResult>

export type SyncResult = { synced: number; failed: number; remaining: number; interrupted: boolean }

// ── Storage ────────────────────────────────────────────────────────────────

export interface QueueStorage {
  getAll(): Promise<QueuedAction[]>
  put(action: QueuedAction): Promise<void>
  delete(id: string): Promise<void>
}

const DB_NAME = 'plants-collector'
const DB_VERSION = 1
const QUEUE_STORE = 'queue'

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

export function indexedDbStorage(): QueueStorage {
  let dbPromise: Promise<IDBDatabase> | null = null
  const db = () =>
    (dbPromise ??= new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION)
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(QUEUE_STORE)) req.result.createObjectStore(QUEUE_STORE, { keyPath: 'id' })
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    }))
  // Writes resolve only when their transaction has committed (not when the
  // request succeeds), so a write reported as saved survives the page being killed.
  const write = async (fn: (store: IDBObjectStore) => void) => {
    const tx = (await db()).transaction(QUEUE_STORE, 'readwrite', { durability: 'strict' })
    fn(tx.objectStore(QUEUE_STORE))
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error ?? new Error('Offline queue write aborted'))
    })
  }
  return {
    getAll: async () => request((await db()).transaction(QUEUE_STORE, 'readonly').objectStore(QUEUE_STORE).getAll() as IDBRequest<QueuedAction[]>),
    put: (action) => write((s) => s.put(action)),
    delete: (id) => write((s) => s.delete(id)),
  }
}

export function memoryStorage(): QueueStorage {
  const items = new Map<string, QueuedAction>()
  return {
    getAll: async () => [...items.values()].map((a) => ({ ...a })),
    put: async (action) => void items.set(action.id, { ...action }),
    delete: async (id) => void items.delete(id),
  }
}

// ── Queue ──────────────────────────────────────────────────────────────────

export class OfflineQueue {
  private actions: QueuedAction[] = []
  private listeners = new Set<() => void>()
  private inFlightId: string | null = null
  private withdrawn = new Set<string>()
  private changes = 0
  private storage: QueueStorage
  private newId: () => string
  readonly ready: Promise<void>

  constructor(storage: QueueStorage, newId: () => string) {
    this.storage = storage
    this.newId = newId
    this.ready = storage
      .getAll()
      .then((all) => {
        this.actions = all.sort((a, b) => a.createdAt - b.createdAt)
        this.notify()
      })
      .catch((err) => console.error('[collector] could not open the offline queue', err))
  }

  /** Snapshot of queued writes for a user, oldest first. */
  list(userId: string): QueuedAction[] {
    return this.actions.filter((a) => a.userId === userId)
  }

  counts(userId: string): { pending: number; failed: number } {
    const mine = this.list(userId)
    return { pending: mine.filter((a) => a.status === 'pending').length, failed: mine.filter((a) => a.status === 'failed').length }
  }

  private snapshots = new Map<string, { version: number; list: QueuedAction[] }>()

  /** Like list(), but the same array until the queue changes (for useSyncExternalStore). */
  snapshot(userId: string): QueuedAction[] {
    const cached = this.snapshots.get(userId)
    if (cached?.version === this.changes) return cached.list
    const list = this.list(userId)
    this.snapshots.set(userId, { version: this.changes, list })
    return list
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  async enqueue(write: QueuedWrite, userId: string): Promise<QueuedAction> {
    await this.ready
    const action = { ...write, id: this.newId(), userId, status: 'pending', error: null, attempts: 0, createdAt: Date.now() } as QueuedAction
    // Persist before reporting success: once this resolves the write survives reloads.
    await this.storage.put(action)
    this.actions.push(action)
    this.notify()
    return action
  }

  /**
   * Withdraws a queued node creation that hasn't been sent yet (the worker
   * cancelled the status picker for a brand-new node). Returns false if it
   * already reached the server, in which case the caller deactivates the node.
   */
  async withdrawCreateNode(nodeId: string): Promise<boolean> {
    await this.ready
    const action = this.actions.find((a) => a.type === 'create_node' && a.record.id === nodeId)
    if (!action || action.id === this.inFlightId) return false
    const dependent = this.actions.some((a) => a !== action && 'record' in a && dependsOnNode(a, nodeId))
    if (dependent) return false
    this.withdrawn.add(action.id)
    await this.remove(action.id)
    return true
  }

  /** True for a queued write that was taken back before it was sent. */
  wasWithdrawn(actionId: string): boolean {
    return this.withdrawn.has(actionId)
  }

  async resetFailed(userId: string): Promise<void> {
    await this.ready
    for (const action of this.list(userId).filter((a) => a.status === 'failed')) {
      await this.update({ ...action, status: 'pending', error: null })
    }
  }

  /**
   * Sends a user's queued writes in the order they were made, so parents
   * (row → stem → node) always reach the database before their children.
   * A network-type failure stops the run and leaves the rest queued; a
   * rejected write is marked failed and kept, never discarded.
   */
  async sync(userId: string, execute: WriteExecutor): Promise<SyncResult> {
    await this.ready
    let synced = 0
    let interrupted = false
    for (const action of this.list(userId)) {
      if (action.status !== 'pending' || !this.actions.includes(action)) continue
      this.inFlightId = action.id
      let result: WriteResult
      try {
        result = await execute(action)
      } catch (err) {
        result = { ok: false, retryable: true, message: err instanceof Error ? err.message : String(err) }
      } finally {
        this.inFlightId = null
      }
      if (result.ok) {
        await this.remove(action.id)
        synced++
      } else if (result.retryable) {
        await this.update({ ...action, attempts: action.attempts + 1, error: result.message })
        interrupted = true
        break
      } else {
        await this.update({ ...action, attempts: action.attempts + 1, status: 'failed', error: result.message })
      }
    }
    const { pending, failed } = this.counts(userId)
    return { synced, failed, remaining: pending, interrupted }
  }

  private async update(action: QueuedAction) {
    await this.storage.put(action)
    this.actions = this.actions.map((a) => (a.id === action.id ? action : a))
    this.notify()
  }

  private async remove(id: string) {
    await this.storage.delete(id)
    this.actions = this.actions.filter((a) => a.id !== id)
    this.notify()
  }

  private notify() {
    this.changes++
    this.listeners.forEach((fn) => fn())
  }
}

function dependsOnNode(action: QueuedAction, nodeId: string): boolean {
  switch (action.type) {
    case 'create_node':
      return action.record.parent_node_id === nodeId
    case 'record_status':
      return action.record.plant_node_id === nodeId
    case 'deactivate_node':
      return action.record.id === nodeId
    default:
      return false
  }
}
