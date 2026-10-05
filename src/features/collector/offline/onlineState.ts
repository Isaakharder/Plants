import { onlineManager } from '@tanstack/react-query'

/**
 * TanStack Query assumes it starts online and only learns otherwise from an
 * `offline` event, which a phone that opened the app with no signal never
 * fires. It then never sees the connection "return", so the row on screen
 * isn't re-read until the worker navigates. Telling it the real state at
 * start-up makes the collector's queries (refetchOnReconnect) re-read once
 * when the `online` event arrives; its own listeners keep it in sync after.
 */
export function syncOnlineState(): void {
  if (typeof navigator !== 'undefined') onlineManager.setOnline(navigator.onLine)
}
