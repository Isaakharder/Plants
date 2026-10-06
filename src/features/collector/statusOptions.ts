import type { NodeStatus } from './types'

// Which statuses the collector's status picker offers for a new entry, from
// the organization's settings (Settings › Mobile status options,
// mobile_status_options). Hiding a status only stops it being chosen again:
// recorded statuses are untouched and still shown on the canvas.

/** The status picker's options, in the order shown. */
export const STATUS_OPTIONS: readonly { value: NodeStatus; label: string }[] = [
  { value: 'Aborted', label: 'Aborted' },
  { value: 'Pruned', label: 'Pruned' },
  { value: 'Flower', label: 'Flower' },
  { value: 'SetFruit', label: 'Set Fruit' },
  { value: 'MatureGreen', label: 'Mature Green' },
  { value: 'BreakerFruit', label: 'Breaker Fruit' },
  { value: 'Harvested', label: 'Harvested' },
]

/** The statuses offered for new entries. */
export type EnabledStatuses = readonly NodeStatus[]

/** Every status: what an organization starts with, and what a device uses until it has downloaded its organization's choice. */
export const ALL_STATUSES: EnabledStatuses = STATUS_OPTIONS.map((o) => o.value)

/** The organization's rows → enabled statuses, in picker order. A status without a row counts as enabled. */
export function enabledFromRows(rows: readonly { status: NodeStatus; enabled: boolean }[]): EnabledStatuses {
  const hidden = new Set(rows.filter((r) => !r.enabled).map((r) => r.status))
  return ALL_STATUSES.filter((s) => !hidden.has(s))
}

/** The downloaded choice, or every status on a device that has never had it. */
export function statusOptionsOrDefaults(downloaded: EnabledStatuses | undefined): { enabled: EnabledStatuses; source: 'organization' | 'defaults' } {
  return downloaded ? { enabled: downloaded, source: 'organization' } : { enabled: ALL_STATUSES, source: 'defaults' }
}

export type PickerOption = { value: NodeStatus; label: string; hidden: boolean }

/**
 * The picker's buttons for a node: the enabled statuses, plus the node's
 * current status if it is hidden, shown as current but not selectable, so a
 * node at a hidden status still shows where it is.
 */
export function pickerOptions(enabled: EnabledStatuses, current: NodeStatus | null | undefined): PickerOption[] {
  const on = new Set(enabled)
  return STATUS_OPTIONS.filter((o) => on.has(o.value) || o.value === current).map((o) => ({ ...o, hidden: !on.has(o.value) }))
}
