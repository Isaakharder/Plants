import { useSyncExternalStore } from 'react'
import { supabase } from '../../../lib/supabase'
import { newId } from './ids'
import { OfflineQueue, indexedDbStorage, type QueuedWrite, type WriteResult } from './offlineQueue'
import { syncOnlineState } from './onlineState'

export type SyncStatus = 'online' | 'offline' | 'syncing' | 'synced' | 'error'

type State = { status: SyncStatus; pending: number; error: string | null }

// ── Queue singleton (created on first use, so tests can import this module) ──

let _queue: OfflineQueue | null = null
export function collectorQueue(): OfflineQueue {
  return (_queue ??= new OfflineQueue(indexedDbStorage(), newId))
}

// ── Sending one write to Supabase ─────────────────────────────────────────────

// Status 0 = the request never got a response (offline, DNS, captive Wi-Fi).
// 401 = expired access token, fixed by the next token refresh.
const isRetryableStatus = (status: number) => status === 0 || status === 401 || status === 408 || status === 429 || status >= 500

export async function executeWrite(write: QueuedWrite): Promise<WriteResult> {
  // Inserts use ON CONFLICT (id) DO NOTHING: replaying a write whose response
  // was lost leaves exactly one record.
  const insertOnce = { onConflict: 'id', ignoreDuplicates: true } as const
  const res = await (() => {
    switch (write.type) {
      case 'create_row':
        return supabase.from('measurement_rows').upsert(write.record, insertOnce)
      case 'create_stem':
        return supabase.from('measurement_stems').upsert(write.record, insertOnce)
      case 'create_node':
        return supabase.from('plant_nodes').upsert(write.record, insertOnce)
      case 'record_status':
        return supabase.from('node_observations').upsert(write.record, insertOnce)
      case 'deactivate_node':
        return supabase.from('plant_nodes').update({ is_active: false }).eq('id', write.record.id)
      case 'upsert_growth':
        // One reading per stem per week; re-saving corrects it.
        return supabase.from('stem_growth_measurements').upsert(write.record, { onConflict: 'measurement_stem_id,year,week_number' })
    }
  })()
  if (!res.error) return { ok: true }
  return { ok: false, retryable: isRetryableStatus(res.status), message: res.error.message }
}

// ── Module-level state ────────────────────────────────────────────────────────

let _userId: string | null = null
let _online = typeof navigator === 'undefined' ? true : navigator.onLine
let _syncing = false
let _justSynced = false
let _lastError: string | null = null
let _state: State = { status: 'online', pending: 0, error: null }

const listeners = new Set<() => void>()
const syncedListeners = new Set<() => void>()

function computeState(): State {
  const { pending, failed } = _userId ? collectorQueue().counts(_userId) : { pending: 0, failed: 0 }
  const unsynced = pending + failed
  let status: SyncStatus
  if (!_online) status = 'offline'
  else if (_syncing) status = 'syncing'
  else if (failed > 0) status = 'error'
  else if (_justSynced && unsynced === 0) status = 'synced'
  else status = 'online'
  const error = failed > 0 ? `${failed} change${failed !== 1 ? 's' : ''} failed to sync${_lastError ? `: ${_lastError}` : ''}` : null
  return { status, pending: unsynced, error }
}

function notify() {
  const next = computeState()
  if (next.status !== _state.status || next.pending !== _state.pending || next.error !== _state.error) {
    _state = next
    listeners.forEach((fn) => fn())
  }
}

// ── Sync orchestration ────────────────────────────────────────────────────────

let _running = false
let _rerun = false

/**
 * Sends queued writes for the signed-in user. Safe to call at any time; a call
 * made while a sync is running schedules one more pass afterwards.
 */
export async function triggerSync(): Promise<void> {
  if (_running) {
    _rerun = true
    return
  }
  _running = true
  try {
    do {
      _rerun = false
      await runSync()
    } while (_rerun)
  } finally {
    _running = false
  }
}

async function runSync() {
  if (!_userId || !navigator.onLine) return
  const queue = collectorQueue()
  await queue.ready
  if (queue.counts(_userId).pending === 0) return notify()

  // Never replay without a live session for the user who made the writes.
  // getSession() also refreshes an expired access token now that we're online.
  const { data } = await supabase.auth.getSession()
  if (data.session?.user.id !== _userId) return notify()

  _syncing = true
  notify()
  try {
    const result = await queue.sync(_userId, executeWrite)
    _lastError = queue.list(_userId).find((a) => a.status === 'failed')?.error ?? null
    if (result.synced > 0) {
      syncedListeners.forEach((fn) => fn())
      if (result.remaining === 0 && result.failed === 0) {
        _justSynced = true
        // Revert to 'online' after a brief visual confirmation
        setTimeout(() => {
          _justSynced = false
          notify()
        }, 2500)
      }
    }
  } finally {
    _syncing = false
    notify()
  }
}

/** "Sync now": give rejected writes another attempt, then sync. */
export async function retryAll(): Promise<void> {
  if (_userId) await collectorQueue().resetFailed(_userId)
  await triggerSync()
}

/** Called after a successful sync, e.g. to refresh server data. */
export function onSynced(fn: () => void): () => void {
  syncedListeners.add(fn)
  return () => syncedListeners.delete(fn)
}

// ── Network event wiring ──────────────────────────────────────────────────────

let _started = false

/**
 * Starts syncing for the signed-in user. Called by the collector once the
 * Plants session is known (CropLink synced at import time, before auth).
 */
export function startCollectorSync(userId: string): void {
  _userId = userId
  if (!_started) {
    _started = true
    syncOnlineState()
    window.addEventListener('online', () => {
      _online = true
      notify()
      void triggerSync()
    })
    window.addEventListener('offline', () => {
      _online = false
      notify()
    })
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') void triggerSync()
    })
    collectorQueue().subscribe(notify)
    // Writes left queued by a dropped connection that the browser still
    // reports as "online" (weak greenhouse Wi-Fi) are retried periodically.
    window.setInterval(() => void triggerSync(), 30_000)
  }
  notify()
  void triggerSync()
}

// ── React hook ────────────────────────────────────────────────────────────────

function subscribe(fn: () => void) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function useNetworkStatus(): State {
  return useSyncExternalStore(subscribe, () => _state)
}

/** Number of writes not yet in the database for this user (pending + failed). */
export function unsyncedCount(userId: string): number {
  const { pending, failed } = collectorQueue().counts(userId)
  return pending + failed
}
