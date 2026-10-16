import { Dialog } from '../../components/Dialog'
import { formatInteger, formatTwoDecimals } from '../../lib/format'
import { cohortCells, type SamplingWeekRow, type SetHarvestCohortRow, type WeeklyPlantDataRow } from './model'
import styles from './WeeklyPlantDataTab.module.css'

/**
 * Sampling detail: the counts behind the table's per-m² values and cohort
 * percentages, for the weeks the table shows. Moved here from the former
 * "Show sampling detail" columns and cell counts; same values.
 */
export function SamplingDetail({
  open,
  onClose,
  year,
  weeks,
  cohortRows,
  samplingRows,
  ages,
  stemsPerM2,
}: {
  open: boolean
  onClose: () => void
  year: number
  weeks: WeeklyPlantDataRow[]
  cohortRows: SetHarvestCohortRow[]
  /** sampling_weeks() by ISO week. */
  samplingRows: Map<number, SamplingWeekRow>
  /** The cohort ages the table shows. */
  ages: number[]
  stemsPerM2: number
}) {
  const harvestAges = ages.filter((a) => a > 0)
  return (
    <Dialog open={open} title="Sampling detail" onClose={onClose} className={`${styles.helpDialog} ${styles.samplingDialog}`}>
      <div className={styles.sampling}>
        <section>
          <h3>Sampled area and new stage entries</h3>
          <p>
            Per week: the stems in the sample, how many were visited (any record, or “✓ Stem checked”) and confirmed checked, the area the
            visited stems represent (visited ÷ {formatTwoDecimals(stemsPerM2)} stems/m²), and the peppers first recorded at each stage. In
            legacy weeks only status changes were recorded, so a stem visited with nothing changed shows as not visited.
          </p>
          <div className={styles.samplingScroll}>
            <table className={styles.samplingTable}>
              <thead>
                <tr>
                  <th scope="col">Week</th>
                  <th scope="col">In sample</th>
                  <th scope="col">Visited</th>
                  <th scope="col">Checked</th>
                  <th scope="col">Sampled m²</th>
                  <th scope="col">New sets</th>
                  <th scope="col">New breakers</th>
                  <th scope="col">Harvested</th>
                </tr>
              </thead>
              <tbody>
                {weeks.map((w) => (
                  <tr key={w.iso_week} className={w.is_sampled ? undefined : styles.unsampled}>
                    <th scope="row">
                      W{w.iso_week}
                      {w.is_baseline && <span className={styles.tag}>Baseline</span>}
                      {w.is_provisional && <span className={`${styles.tag} ${styles.provisional}`}>In progress</span>}
                    </th>
                    <td>{formatInteger(samplingRows.get(w.iso_week)?.expected_stems ?? 0)}</td>
                    <td>{w.is_sampled ? formatInteger(w.sampled_stems) : '—'}</td>
                    <td>{samplingRows.get(w.iso_week)?.tracking === 'explicit' ? formatInteger(samplingRows.get(w.iso_week)!.checked_stems) : 'legacy'}</td>
                    <td>{w.sampled_m2 === null ? '—' : formatTwoDecimals(w.sampled_m2)}</td>
                    <td>{w.is_sampled ? formatInteger(w.new_sets) : '—'}</td>
                    <td>{w.is_sampled ? formatInteger(w.new_breakers) : '—'}</td>
                    <td>{w.is_sampled ? formatInteger(w.new_harvested) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section>
          <h3>Cohort harvest counts</h3>
          <p>
            Per set week: the peppers set (+0), and how many of them were first harvested at each age: the counts behind the table’s +N
            percentages (harvested ÷ sets). — where that harvest week hasn’t been sampled.
          </p>
          <div className={styles.samplingScroll}>
            <table className={styles.samplingTable}>
              <thead>
                <tr>
                  <th scope="col">Set week</th>
                  <th scope="col">Sets</th>
                  {harvestAges.map((a) => (
                    <th key={a} scope="col">+{a}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {weeks.map((w) => {
                  const cells = cohortCells(cohortRows, year, w.iso_week)
                  const sets = cells[0]?.cohort_sets ?? 0
                  return (
                    <tr key={w.iso_week} className={sets === 0 ? styles.unsampled : undefined}>
                      <th scope="row">W{w.iso_week}</th>
                      <td>{sets === 0 ? '—' : formatInteger(sets)}</td>
                      {harvestAges.map((a) => {
                        const cell = cells.find((c) => c.delay === a)
                        return <td key={a}>{sets === 0 || !cell || cell.percent === null ? '—' : formatInteger(cell.harvested)}</td>
                      })}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </Dialog>
  )
}
