// Revised official forecasts (20261107000000_official_forecast_revisions.sql).
// A Breakers-only official forecast's Ready % can be revised until its
// sampling week ends (Monday 00:00 greenhouse time of the week it forecasts,
// the run's first_target_starts). A revision is a new version; every version
// is kept, and the latest version of a sampling week is the one that counts.
// The server enforces the deadline; these helpers only decide what to offer.

type RunLike = { id: string; crop_id: string; origin_year: number; origin_week: number; revision: number; basis: string; first_target_starts: string }

const weekKey = (r: Pick<RunLike, 'crop_id' | 'origin_year' | 'origin_week'>) => `${r.crop_id}:${r.origin_year}:${r.origin_week}`

/** The version that counts for each sampling week: its latest revision. */
export function latestRevisions<T extends RunLike>(runs: T[]): T[] {
  const by = new Map<string, T>()
  for (const r of runs) {
    const cur = by.get(weekKey(r))
    if (!cur || r.revision > cur.revision) by.set(weekKey(r), r)
  }
  return [...by.values()]
}

/** The latest version of the run's sampling week (the run itself when it is the latest). */
export function latestOf<T extends RunLike>(runs: T[], run: T): T {
  return runs.filter((r) => weekKey(r) === weekKey(run)).reduce((a, b) => (b.revision > a.revision ? b : a), run)
}

/** When the sampling week ends and its official forecast becomes final. */
export const revisionDeadline = (run: Pick<RunLike, 'first_target_starts'>) => new Date(run.first_target_starts)

/** Its Ready % can still be revised: Breakers only, the week's latest version, before the week ended. */
export function revisable<T extends RunLike>(runs: T[], run: T, now: Date): boolean {
  return run.basis === 'breaker_only' && latestOf(runs, run).id === run.id && now.getTime() < Date.parse(run.first_target_starts)
}
