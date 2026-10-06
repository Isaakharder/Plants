import { Dialog } from '../../components/Dialog'
import { formatInteger, formatTwoDecimals } from '../../lib/format'
import styles from './WeeklyPlantDataTab.module.css'

/** Help › Weekly Plant Data: what every column, cell and marker means. Moved here from above the table. */
export function WeeklyPlantDataHelp({
  open,
  onClose,
  stemsPerM2,
  areaM2,
  hiddenAges,
  startMarker,
}: {
  open: boolean
  onClose: () => void
  stemsPerM2: number
  areaM2: number
  /** Cohort ages hidden because nothing was harvested at them this year (e.g. +0, +1, +2). */
  hiddenAges: number[]
  /** Whether the +0 column (with its ● start markers) is shown. */
  startMarker: boolean
}) {
  return (
    <Dialog open={open} title="Weekly Plant Data help" onClose={onClose} className={styles.helpDialog}>
      <div className={styles.help}>
        <section>
          <h3>Weekly plant data</h3>
          <p>
            Peppers on the sampled plants that entered each stage that week, per sampled m². Each pepper counts once per stage, in the first week it
            was recorded there.
          </p>
          <dl>
            <div>
              <dt>Sampled m²</dt>
              <dd>Sampled stems ÷ {formatTwoDecimals(stemsPerM2)} stems/m² (this variety’s picking stems ÷ its area).</dd>
            </div>
            <div>
              <dt>Sampling detail</dt>
              <dd>The button above the table opens the counts behind these values: sampled stems, sampled m², new stage entries and each cohort’s harvest counts.</dd>
            </div>
          </dl>
        </section>

        <section>
          <h3>Cohort tracking</h3>
          <dl>
            <div>
              <dt>Sets/m²</dt>
              <dd>Peppers first recorded as set that week, per sampled m². Every set week starts its own cohort.</dd>
            </div>
            <div>
              <dt>+0 … +10</dt>
              <dd>
                Every set week starts its own cohort at +0 and moves one row down and one column right each week; a cell is the share of that
                original cohort first harvested at exactly that age. Cells show whole percentages; hover for the exact value and the counts.
                {hiddenAges.length > 0 && <> Ages with no harvests in this year are hidden ({hiddenAges.map((a) => `+${a}`).join(', ')}).</>}
              </dd>
            </div>
            <div>
              <dt>Following a cohort</dt>
              <dd>
                Click a week’s Sets/m²{startMarker && <> (or its <span className={styles.startSample}>●</span> at +0)</>} to highlight that cohort’s
                ladder; click again or press Esc to release. Hovering previews a cohort while none is selected.
              </dd>
            </div>
            <div>
              <dt>
                <span className={styles.baselineSample}>12.3%</span>
              </dt>
              <dd>From the baseline set cohort. Those peppers may have set before sampling began, so their real set → harvest delay may be longer.</dd>
            </div>
            <div>
              <dt>Cohort Loss</dt>
              <dd>
                Shown above the table when following a cohort: of the peppers set that week, the share aborted, pruned or still unresolved by +10,
                once its +10 window closes, with Aborted, Pruned and Unresolved by +10 listed separately. A Harvested record at +11 or later still
                counts in Harvested/m².
              </dd>
            </div>
          </dl>
        </section>

        <section>
          <h3>Harvest &amp; weight</h3>
          <dl>
            <div>
              <dt>Harvested/m²</dt>
              <dd>Peppers first recorded Harvested that calendar week, per sampled m², whichever week they set.</dd>
            </div>
            <div>
              <dt>AFW g</dt>
              <dd>
                Harvest-week AFW: the average weight, in grams, of the peppers harvested in that calendar week (whichever week they set). It can be
                entered for future weeks too, but that alone creates no Picked kg. Type down the column — Enter or Tab moves to the next week — then
                Save.
              </dd>
            </div>
            <div>
              <dt>Picked kg</dt>
              <dd>
                Estimated kg picked in that calendar week for the whole crop: Harvested/m² × {formatInteger(areaM2)} m² × that week’s AFW ÷ 1000.
                Only recorded harvests count; — until the week has been sampled, and nothing is projected. The in-progress week may be incomplete.
              </dd>
            </div>
          </dl>
        </section>

        <section>
          <h3>Fruit loss</h3>
          <dl>
            <div>
              <dt>Fruit Loss %</dt>
              <dd>
                Fruit lost that calendar week ÷ fruit on the plants at its start. Fruit counts from the week after it sets, until it is harvested or
                lost; each lost fruit counts once, in the week it was first recorded Aborted or Pruned (an Aborted later followed by a live record is
                a correction, not a loss). — when the week hasn’t been sampled.
              </dd>
            </div>
            <div>
              <dt>Flowers</dt>
              <dd>Flowers lost before setting fruit are not included in Fruit Loss %.</dd>
            </div>
          </dl>
        </section>

        <section>
          <h3>Table indicators</h3>
          <dl>
            <div>
              <dt>—</dt>
              <dd>Not sampled that week. In Picked kg it also means no AFW has been entered; in Fruit Loss %, no fruit was on the plants.</dd>
            </div>
            <div>
              <dt>
                <span className={styles.tag}>Baseline</span>
              </dt>
              <dd>First sampling week. There was no earlier visit, so it can include stages reached before sampling began.</dd>
            </div>
            <div>
              <dt>
                <span className={`${styles.tag} ${styles.provisional}`}>In progress</span>
              </dt>
              <dd>The current greenhouse week. Sampling may not be complete, so its values can still change.</dd>
            </div>
            <div>
              <dt>Picked kg shading</dt>
              <dd>Grey for past weeks, amber for the current week, a lighter tint for future weeks.</dd>
            </div>
          </dl>
        </section>
      </div>
    </Dialog>
  )
}
