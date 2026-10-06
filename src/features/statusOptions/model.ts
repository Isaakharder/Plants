import { ALL_STATUSES, STATUS_OPTIONS, type EnabledStatuses } from '../collector/statusOptions'
import type { NodeStatus } from '../collector/types'

// Settings › Mobile status options: form values ↔ rows. At least one status
// must stay enabled (the database checks the same).

export type StatusDraft = Record<NodeStatus, boolean>

export const draftFromEnabled = (enabled: EnabledStatuses): StatusDraft =>
  Object.fromEntries(STATUS_OPTIONS.map((o) => [o.value, enabled.includes(o.value)])) as StatusDraft

export const enabledCount = (draft: StatusDraft) => ALL_STATUSES.filter((s) => draft[s]).length

/** An error message when the draft can't be saved (none = valid). */
export const validateStatusDraft = (draft: StatusDraft): string | null => (enabledCount(draft) === 0 ? 'Keep at least one status available.' : null)

/** One row per status, so a save sets every status explicitly. */
export const rowsFromStatusDraft = (organizationId: string, draft: StatusDraft) =>
  ALL_STATUSES.map((status) => ({ organization_id: organizationId, status, enabled: draft[status] }))

export const sameStatusDraft = (a: StatusDraft, b: StatusDraft) => ALL_STATUSES.every((s) => a[s] === b[s])
