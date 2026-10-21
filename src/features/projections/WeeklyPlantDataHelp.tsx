import { Dialog } from '../../components/Dialog'
import { formatInteger, formatTwoDecimals } from '../../lib/format'
import styles from './WeeklyPlantDataTab.module.css'

/** Help › Weekly Plant Data: what every column, cell and marker means. Moved here from above the table. */
export function WeeklyPlantDataHelp({
  open,
  onClose,
  stemsPerM2,
  areaM2,
  hiddenAges: _hiddenAges,
  startMarker: _startMarker,
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
              <dd>Visited stems ÷ {formatTwoDecimals(stemsPerM2)} stems/m² (this variety’s picking stems ÷ its area).</dd>
            </div>
            <div>
              <dt>Stems</dt>
              <dd>
                Sampled stems visited that week ÷ stems in the sample. A stem counts as visited only when there is evidence: a status record, a
                growth reading, a new node, or “✓ Stem checked” in the collector. Per-m² values use the visited stems only; an unvisited stem is
                never a zero. <span className={styles.coveragePartial}>Amber</span>: a finished week with stems missing. ✓: sampling marked
                complete. <span className={styles.coverageLegacy}>Dotted</span>: a legacy week from before “✓ Stem checked”, when only status
                changes were recorded, so complete inspection of every node can’t be verified.
              </dd>
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
              <dt>Cohort</dt>
              <dd>
                What became of the peppers set that week, as recorded: <strong>harvested</strong>, <strong>aborted</strong>, <strong>pruned</strong>,{' '}
                <strong>unresolved</strong> (no outcome recorded by +10 weeks, once the window has closed; not counted as lost) and{' '}
                <strong>still on plant</strong>. The bar always adds up to the week’s sets; nothing is assumed to be harvested.
              </dd>
            </div>
            <div>
              <dt>Cohort details</dt>
              <dd>
                Click a week’s Sets/m² or its Cohort bar to open the cohort under that week (one at a time; click again or press Esc to close). It shows
                the outcome and, for each week of age (+3 … +10), the share first harvested that week, in %, per m² or kg (kg uses that harvest week’s
                AFW). A week is shown as <em>0%</em> only when it was sampled and nothing was harvested; otherwise it reads <em>not sampled</em>,{' '}
                <em>not recorded</em> (Breakers-only weeks: Harvested isn’t recorded), <em>⚠</em> (partial visit or harvests possibly not recorded),{' '}
                <em>this week</em> or <em>not yet</em>. A baseline cohort’s peppers may have set before sampling began, so their ages may be longer.
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
            <div>
              <dt>Harvestable</dt>
              <dd>
                Peppers marked Harvestable (ready to pick) in the collector that week, each counted once. A same-week estimate: it counts for that
                week only, never carries into the next week, and doesn’t change Breakers, Harvested, cohorts or the Harvest Forecast. “n picked”:
                marked peppers recorded Harvested later that week; they are already in Picked kg, so only the rest is added to the week’s projection
                (see the Harvestable kg tooltip).
              </dd>
            </div>
            <div>
              <dt>Harvestable/m² · kg</dt>
              <dd>
                Harvestable ÷ sampled m². A week still in progress (or not sampled) uses the last sampled week’s area, since a midweek count comes
                before that week’s walkthrough. Kg: Harvestable/m² × {formatInteger(areaM2)} m² × AFW ÷ 1000, using that week’s AFW or else the most
                recent one entered.
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
