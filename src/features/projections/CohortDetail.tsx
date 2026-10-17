// Weekly Plant Data › Cohort column and its expandable detail row: one
// fruit-set week followed through harvest (display only; see cohortTimeline.ts).

import { useState } from 'react'
import { formatInteger } from '../../lib/format'
import { harvestedKgSoFar, inUnit, shownAges, weekRanges, type AgeCell, type AgeState, type CohortDetail, type Unit } from './cohortTimeline'
import styles from './WeeklyPlantDataTab.module.css'

const pct = (share: number) => `${(100 * share).toFixed(share > 0 && share < 0.01 ? 1 : 0)}%`

/** The compact outcome bar for the Cohort column: harvested · aborted · pruned · unresolved · still on plant. */
export function CohortBar({ detail, open, onToggle }: { detail: CohortDetail | null; open: boolean; onToggle: () => void }) {
  if (!detail || detail.sets === 0) return <span className={styles.dash}>—</span>
  const o = detail.outcome
  const segs: [string, number, string][] = [
    [styles.segHarvested, o.harvested, 'Harvested'],
    [styles.segAborted, o.aborted, 'Aborted'],
    [styles.segPruned, o.pruned, 'Pruned'],
    [styles.segUnresolved, o.unresolved, 'Unresolved by +10'],
    [styles.segOnPlant, o.onPlant, 'Still on plant'],
  ]
  const title = `W${detail.setWeek} cohort, ${detail.sets} sets: ` + segs.filter(([, n]) => n > 0).map(([, n, label]) => `${label} ${pct(n / detail.sets)}`).join(' · ')
  return (
    <button type="button" className={styles.cohortBar} onClick={onToggle} aria-expanded={open} title={title} aria-label={`${title}. Show details`}>
      {segs.map(([cls, n, label]) => (n > 0 ? <span key={label} className={cls} style={{ flexGrow: n }} /> : null))}
    </button>
  )
}

const STATE_LABEL: Record<AgeState, string> = {
  recorded: '',
  incomplete: '',
  not_recorded: 'not recorded',
  not_sampled: 'not sampled',
  in_progress: 'this week',
  future: 'not yet',
}

function fmt(v: number | null, unit: Unit): string {
  if (v === null) return '—'
  if (unit === 'percent') return `${v.toFixed(v > 0 && v < 1 ? 1 : 0)}%`
  if (unit === 'perM2') return v.toFixed(2)
  return formatInteger(Math.round(v))
}

const UNIT_LABEL: Record<Unit, string> = { percent: '%', perM2: 'per m²', kg: 'kg' }


/** The expanded row: the cohort's outcome and its harvest at each week of age. */
export function CohortDetailPanel({ detail, afwOf, areaM2 }: { detail: CohortDetail; afwOf: (week: number) => number | null; areaM2: number }) {
  const [unit, setUnit] = useState<Unit>('percent')
  const o = detail.outcome
  const ages = shownAges(detail)
  const value = (count: number) => inUnit(count, detail, unit)
  const ageValue = (a: AgeCell) => (a.harvested === null ? null : unit === 'kg' ? inUnit(a.harvested, detail, 'kg', { afwG: afwOf(a.harvestWeek), areaM2 }) : value(a.harvested))
  const harvestedKg = unit === 'kg' ? harvestedKgSoFar(detail, afwOf, areaM2) : null
  const outcome: [string, number, string][] = [
    ['Harvested', o.harvested, styles.segHarvested],
    ['Aborted', o.aborted, styles.segAborted],
    ['Pruned', o.pruned, styles.segPruned],
    ['Still on plant', o.onPlant, styles.segOnPlant],
    ['Unresolved', o.unresolved, styles.segUnresolved],
  ]
  // One line per reason, with the weeks it applies to (e.g. "W42–W44: Breakers-only week …").
  const byNote = new Map<string, number[]>()
  for (const a of ages) if (a.note && a.state !== 'in_progress') byNote.set(a.note, [...(byNote.get(a.note) ?? []), a.harvestWeek])
  const notes = [...byNote.entries()].map(([note, weeks]) => ({ note, weeks: weekRanges(weeks) }))
  const breakerGap = ages.some((a) => a.state === 'not_recorded')

  return (
    <div className={styles.cohortDetail}>
      <div className={styles.cohortDetailHead}>
        <strong>
          W{detail.setWeek} cohort · {detail.sets} peppers set{detail.setsPerM2 !== null ? ` (${detail.setsPerM2.toFixed(2)}/m²)` : ''} ·{' '}
          {detail.closed ? 'closed after +10' : 'open'}
        </strong>
        <span className={styles.unitToggle} role="group" aria-label="Units">
          {(['percent', 'perM2', 'kg'] as Unit[]).map((u) => (
            <button key={u} type="button" className={unit === u ? styles.unitActive : undefined} aria-pressed={unit === u} onClick={() => setUnit(u)}>
              {UNIT_LABEL[u]}
            </button>
          ))}
        </span>
      </div>

      <dl className={styles.outcomeList}>
        {outcome.map(([label, n, cls]) => (
          <div key={label}>
            <dt>
              <span className={`${styles.legendSwatch} ${cls}`} aria-hidden="true" />
              {label}
            </dt>
            <dd>
              {label === 'Harvested' && unit === 'kg'
                ? harvestedKg!.kg === null
                  ? '—'
                  : `${harvestedKg!.complete ? '' : '≥ '}${formatInteger(Math.round(harvestedKg!.kg))}`
                : unit === 'kg'
                  ? '—'
                  : fmt(value(n), unit)}
            </dd>
          </div>
        ))}
      </dl>

      <div className={styles.ageStrip} role="table" aria-label={`W${detail.setWeek} cohort: first harvested at each week of age (${UNIT_LABEL[unit]})`}>
        {ages.map((a) => {
          const v = ageValue(a)
          return (
            <div key={a.delay} role="row" className={`${styles.ageCell} ${styles[`age_${a.state}`]}`} title={a.note ?? undefined}>
              <span role="rowheader" className={styles.ageLabel}>
                +{a.delay} <span>W{a.harvestWeek}</span>
              </span>
              <span role="cell" className={styles.ageValue}>
                {a.harvested === null ? STATE_LABEL[a.state] : unit === 'kg' && v === null ? 'AFW needed' : fmt(v, unit)}
                {a.state === 'in_progress' && a.harvested !== null && ' so far'}
                {a.state === 'incomplete' && <span className={styles.ageWarn} aria-label="incomplete"> ⚠</span>}
              </span>
            </div>
          )
        })}
      </div>

      {(notes.length > 0 || detail.baseline || unit === 'kg' || (breakerGap && o.onPlant > 0)) && (
        <ul className={styles.cohortNotes}>
          {notes.map((n) => (
            <li key={n.note}>
              {n.weeks}: {n.note}
            </li>
          ))}
          {breakerGap && o.onPlant > 0 && <li>Still on plant includes fruit whose stage isn’t recorded in Breakers-only weeks.</li>}
          {detail.baseline && <li>Baseline cohort: these peppers may have set before sampling began, so their ages may be longer.</li>}
          {unit === 'kg' && <li>Kg uses each harvest week’s AFW; lost and unharvested fruit has no weight.</li>}
        </ul>
      )}
    </div>
  )
}
