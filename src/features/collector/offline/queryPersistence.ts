import { dehydrate, hydrate, type QueryClient } from '@tanstack/react-query'
import { supabase } from '../../../lib/supabase'

// Keeps the collector's server data on the device so it can reopen with no
// signal. CropLink did this by caching same-origin /api responses in its
// service worker; Plants reads from *.supabase.co (cross-origin, per-user,
// authenticated), which a service worker must not cache. Instead, the
// TanStack Query cache for the collector and the user's organization is
// saved to IndexedDB and restored at startup.

const DB_NAME = 'plants-query-cache'
const STORE = 'cache'
const KEY = 'collector'
// Bump when the shape of persisted query data changes.
const BUSTER = 'v1'
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

type Snapshot = { buster: string; savedAt: number; state: ReturnType<typeof dehydrate> }

const PERSISTED_ROOTS = new Set(['collector', 'organization'])

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(STORE)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function withStore<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const req = fn(db.transaction(STORE, mode).objectStore(STORE))
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

let started = false

/** Restores the saved cache, then keeps saving it as queries change. */
export async function startQueryPersistence(client: QueryClient): Promise<void> {
  if (started || typeof indexedDB === 'undefined') return
  started = true

  try {
    // The app waits for this before rendering; never let a stuck IndexedDB block it.
    const timeout = new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 1500))
    const saved = await Promise.race([withStore<Snapshot | undefined>('readonly', (s) => s.get(KEY)), timeout])
    if (saved && saved.buster === BUSTER && Date.now() - saved.savedAt < MAX_AGE_MS) {
      // hydrate() never overwrites data that is newer than the snapshot.
      hydrate(client, saved.state)
    }
  } catch (err) {
    console.warn('[collector] could not restore cached data', err)
  }

  let timer: number | undefined
  const saveNow = () => {
    window.clearTimeout(timer)
    timer = undefined
    const state = dehydrate(client, {
      shouldDehydrateQuery: (q) => q.state.status === 'success' && PERSISTED_ROOTS.has(String(q.queryKey[0])),
    })
    const snapshot: Snapshot = { buster: BUSTER, savedAt: Date.now(), state }
    withStore('readwrite', (s) => s.put(snapshot, KEY)).catch((err) => console.warn('[collector] could not cache data', err))
  }
  // At most every 500 ms (a steady stream of changes must not postpone it),
  // and straight away when the app goes to the background.
  const save = () => {
    if (timer === undefined) timer = window.setTimeout(saveNow, 500)
  }
  client.getQueryCache().subscribe((event) => {
    if (event.type === 'added' || event.type === 'removed' || (event.type === 'updated' && event.action.type === 'success')) save()
  })
  const flush = () => timer !== undefined && saveNow()
  window.addEventListener('pagehide', flush)
  document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && flush())

  // Don't leave one user's greenhouse data on a shared device after sign-out.
  // (Unsynced writes are kept: they belong to that user and replay only for them.)
  supabase.auth.onAuthStateChange((event) => {
    if (event !== 'SIGNED_OUT') return
    client.removeQueries({ queryKey: ['collector'] })
    client.removeQueries({ queryKey: ['organization'] })
    window.clearTimeout(timer)
    timer = undefined
    withStore('readwrite', (s) => s.delete(KEY)).catch(() => {})
  })
}
