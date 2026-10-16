// The forecast basis settings in effect, by start week (append-only history:
// for each start week the newest entry wins).

import type { ForecastBasisSettingRow } from '../../lib/database.types'

const yw = (r: Pick<ForecastBasisSettingRow, 'from_year' | 'from_week'>) => r.from_year * 100 + r.from_week

/** The entries in effect, by start week (for each start week the newest entry wins). */
export function basisTimeline(rows: ForecastBasisSettingRow[]): ForecastBasisSettingRow[] {
  const byWeek = new Map<number, ForecastBasisSettingRow>()
  for (const r of rows) {
    const cur = byWeek.get(yw(r))
    if (!cur || r.created_at > cur.created_at) byWeek.set(yw(r), r)
  }
  return [...byWeek.values()].sort((a, b) => yw(a) - yw(b))
}

