import type { NodeStatus } from './types'

/**
 * Harvestable: a same-week harvest count. A worker marks a pepper that is
 * ready to pick this week; the mark is its own record (harvestable_marks),
 * never a node status, so the node's status history, Breaker date, photos and
 * the Friday walkthrough are untouched. It counts for the greenhouse week of
 * the tap only.
 *
 * Rollback switch: VITE_HARVESTABLE=off hides the button and the canvas
 * labels; recorded marks stay stored.
 */
export const HARVESTABLE_ENABLED = import.meta.env.VITE_HARVESTABLE !== 'off'

/** Fruit still on the plant: what can be marked Harvestable. */
const ON_PLANT: ReadonlySet<NodeStatus> = new Set(['SetFruit', 'MatureGreen', 'BreakerFruit'])

/** A node can be marked when its latest status is fruit still on the plant; one already marked can always be taken back. */
export function canMarkHarvestable(latest: NodeStatus | null | undefined, markedThisWeek: boolean): boolean {
  return markedThisWeek || (latest != null && ON_PLANT.has(latest))
}
