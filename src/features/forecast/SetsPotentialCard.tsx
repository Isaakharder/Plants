import { useMemo, useState } from 'react'
import type { Crop } from '../crops/model'
import { formatTwoDecimals } from '../../lib/format'
import { MAX_AGE, PROVISIONAL_ASSUMPTIONS, SETS_MODEL_VERSION, harvestedOf, lostOf, type Cohort, type Parameter, type PotentialWeek, type SetsWeek } from './engine/sets'
import { weekIndex, weekLabel } from './engine/weeks'
import { formatCount, type ForecastView } from './forecastView'
import { buildSetsPotential, useSetsOutlookData } from './setsOutlookData'
import styles from './HarvestForecastTab.module.css'

const pct = (share: number) => `${Math.round(100 * share)}%`

const WEEK_STATUS: Record<SetsWeek['status'], string> = {
  used: '',
  in_progress: 'Week in progress: may still change',
  baseline: 'Baseline week: fruit already on the plants, not new Sets (excluded)',
  not_sampled: 'Not sampled: unknown, not zero',
  partly_sampled: 'Too few stems visited: unknown, not zero',
  possible_catchup: 'Possible catch-up: nearly all new Sets were first recorded already set, so they may have set earlier (excluded)',
}

/** "6 wks 30%" pairs of a timing distribution. */
const timingText = (timing: number[]) =>
  timing
    .map((share, d) => [d, share] as const)
    .filter(([, share]) => share >= 0.005)
    .map(([d, share]) => `${d} wks ${pct(share)}`)
    .join(' · ')

function KindTag({ p }: { p: Parameter<unknown> }) {
  return <span className={p.kind === 'measured' ? styles.tagMeasured : styles.tagProvisional}>{p.kind === 'measured' ? 'Measured' : 'Provisional'}</span>
}

const survivalTitle = (p: PotentialWeek) =>
  `${pct(p.stillOnPlantSurvival)} of the peppers still on the plant expected to be harvested (${
    p.survivalBasis === 'measured at age'
      ? 'measured for peppers still on the plant at this age'
      : 'survival budget: the assumed total losses minus those already seen, never below zero'
  })`

/**
 * Experimental Sets production potential (engine/sets.ts): what each week's
 * genuinely new Sets may yield, and when, from Plants' own observations only.
 * Planning estimates recalculated on the page, never saved and never part of
 * the official forecast. Next week stays the Breakers forecast; the two are
 * never added.
 */
export function SetsPotentialCard({
  crop,
  originWeek,
  year,
  currentWeek,
  next,
  nextSource,
}: {
  crop: Crop
  originWeek: number
  year: number
  currentWeek: number
  next: ForecastView['weeks'][number] | null
  nextSource: string | null
}) {
  const data = useSetsOutlookData(crop.id, year, true)
  // Provisional survival to try (page only; nothing is saved). Null: the stated assumption.
  const [survivalText, setSurvivalText] = useState<string | null>(null)
  const typed = survivalText === null ? null : Number(survivalText.replace(',', '.'))
  const tried = typed !== null && Number.isFinite(typed) && typed > 0 && typed <= 100 ? typed / 100 : undefined
  // Weeks flagged as possible catch-up are left out unless the viewer includes them (page only).
  const [includeCatchup, setIncludeCatchup] = useState(false)
  const result = useMemo(
    () =>
      data.data
        ? buildSetsPotential(data.data, Number(crop.area_m2), year, originWeek, currentWeek, { provisionalSurvival: tried, includePossibleCatchup: includeCatchup })
        : null,
    [data.data, crop.area_m2, year, originWeek, currentWeek, tried, includeCatchup],
  )
  const caseWeight = crop.case_weight_kg === null ? null : Number(crop.case_weight_kg)
  if (data.isPending) return null
  if (data.error || !result) {
    const message = (data.error as { message?: string } | null)?.message ?? 'no data'
    return <p className={styles.inlineNotes}>Sets production potential unavailable: {message}</p>
  }

  const label = (index: number) => weekLabel(index, year)
  const { parameters, potential, outlook, dueNextWeek } = result
  const { survival, timing } = parameters
  const origin = weekIndex(year, originWeek)
  // Sampling weeks listed: the recent ones with any Plants Sets data (excluded ones say why).
  const shownWeeks = result.weeks.filter((w) => w.status !== 'not_sampled' && w.index > origin - 10).reverse()
  const incomplete = parameters.incomplete
  const sumOf = (f: (c: Cohort) => number) => incomplete.reduce((s, c) => s + f(c), 0)
  const incompleteSets = sumOf((c) => c.sets)
  const anyPartial = outlook.some((w) => w.coverage > 0 && w.coverage < 0.995)
  const flagged = result.weeks.filter((w) => w.status === 'possible_catchup')
  const afwText = (() => {
    const grams = [...new Set(outlook.map((w) => w.afwG))]
    if (grams.length === 0) return 'none entered'
    return grams.map((g) => (g === null ? 'none' : `${g.toFixed(0)} g`)).join(' / ')
  })()

  return (
    <div className={styles.card}>
      <div className={styles.cardHead}>
        <h2 className={styles.compactTitle}>
          Sets production potential
          <span className={styles.titleSep}>·</span>
          <span className={styles.statusExperimental}>Experimental · Estimated</span>
        </h2>
        <span className={styles.versionNote}>
          Planning estimate, not a forecast · from the W{originWeek} sampling · {SETS_MODEL_VERSION}
        </span>
      </div>

      <ul className={styles.inlineNotes}>
        <li>Not an official forecast or production commitment, and not yet checked against actual harvests. The official next-week forecast is the Breakers row.</li>
        <li>
          Harvest timing is {timing.kind === 'provisional' ? 'an assumption (5–8 weeks after set)' : 'measured from completed cohorts'} and not validated as a forecast.
        </li>
        {survival.kind === 'provisional' && <li>Survival is an assumption: {crop.name} doesn’t have enough completed cohorts of its own yet.</li>}
        {survival.kind === 'measured' && parameters.completed.length > 0 && (
          <li>
            Survival is measured on cohorts set {label(parameters.completed.at(-1)!.setIndex)}–{label(parameters.completed[0].setIndex)}; fruit set later in the
            season may fare differently.
          </li>
        )}
        {result.weeks.some((w) => w.inProgress && w.perM2 !== null) && <li>The week in progress is included with the stems visited so far; it may still change.</li>}
        {flagged.length > 0 && (
          <li>
            {flagged.map((w) => `${label(w.index)}: ${pct(w.firstSeenShare ?? 0)}`).join(', ')} of the new Sets were first recorded already set (no earlier
            flower record), so that fruit may have set before the week: possible catch-up after recording began.{' '}
            {includeCatchup ? 'Included at your request: treat its kg as an upper estimate.' : 'Left out.'}{' '}
            <button type="button" className="button button-link" onClick={() => setIncludeCatchup((v) => !v)}>
              {includeCatchup ? 'Leave it out' : 'Include it anyway'}
            </button>
          </li>
        )}
        {anyPartial && (
          <li>
            Harvest weeks marked “Incomplete coverage” would also get fruit from set weeks with no usable Sets (before recording began, or not sampled): only
            recorded Sets are counted, so those weeks’ figures are incomplete, not a guaranteed minimum.
          </li>
        )}
      </ul>

      <dl className={styles.assumptions}>
        <div>
          <dt>
            Survival <KindTag p={survival} />
          </dt>
          <dd>
            <strong>{pct(survival.value)}</strong> of set peppers harvested · {survival.basis}.{' '}
            {survival.kind === 'measured'
              ? 'Peppers still on the plant use the share later harvested among peppers still on the plant at the same age, so losses already seen are never counted twice.'
              : 'Each week keeps its own record: expected further losses are the assumed total minus those already seen, and never more than what is still on the plant.'}
            {survival.kind === 'provisional' && (
              <label className={styles.survivalTry}>
                Try another %
                <input
                  className={`input ${styles.readyInput}`}
                  inputMode="decimal"
                  value={survivalText ?? String(Math.round(100 * PROVISIONAL_ASSUMPTIONS.survival))}
                  onChange={(e) => setSurvivalText(e.target.value)}
                  aria-label="Provisional survival %"
                  aria-invalid={survivalText !== null && tried === undefined}
                />
                <span className={styles.dash}>page only, not saved</span>
              </label>
            )}
          </dd>
        </div>
        <div>
          <dt>
            Maturation timing <KindTag p={timing} />
          </dt>
          <dd>
            Weeks from set to harvest: {timingText(timing.value)} · {timing.basis}
          </dd>
        </div>
        <div>
          <dt>AFW</dt>
          <dd>The grower’s AFW for each harvest week, else the latest entered ({afwText}).</dd>
        </div>
        <div>
          <dt>Cohorts still maturing</dt>
          <dd>
            {incomplete.length === 0
              ? 'None.'
              : `${incomplete.length === 1 ? label(incomplete[0].setIndex) : `${label(incomplete.at(-1)!.setIndex)}–${label(incomplete[0].setIndex)}`}: ${incompleteSets} set peppers; so far ${pct(sumOf(harvestedOf) / incompleteSets)} harvested, ${pct(sumOf(lostOf) / incompleteSets)} aborted or pruned, ${pct(sumOf((c) => c.onPlant) / incompleteSets)} still on the plant. Still-maturing fruit is not counted as lost; these cohorts are not used to measure survival or timing until their ${MAX_AGE}-week window is over.`}
          </dd>
        </div>
      </dl>

      <h3 className={styles.subTitle}>By sampling week: what its new Sets may yield (whole crop)</h3>
      <div className={styles.historyWrap}>
        <table className={`${styles.table} ${styles.historyTable}`}>
          <thead>
            <tr>
              <th scope="col">Set week</th>
              <th scope="col" title="Peppers that genuinely set that week on the sampled stems, per sampled m² (catch-up positions removed)">New Sets/m²</th>
              <th scope="col" title="New Sets/m² × area">Fruit set</th>
              <th scope="col" title="Already harvested (observed)">Harvested</th>
              <th scope="col" title="Already aborted or pruned (observed)">Lost</th>
              <th scope="col" title="Still on the plant: immature, not lost (observed)">On plant</th>
              <th scope="col" title="Of the peppers still on the plant, those expected to abort or be pruned">Further losses</th>
              <th scope="col" title="Harvested + expected future harvest: never more than harvested + on plant">Expected harvest</th>
              <th scope="col" title="Kg already harvested + expected kg, each week at its AFW">Eventual kg</th>
              <th scope="col">Future kg by harvest week</th>
            </tr>
          </thead>
          <tbody>
            {shownWeeks.map((w) => {
              const p = potential.find((x) => x.setIndex === w.index)
              return (
                <tr key={w.index}>
                  <th scope="row">
                    <span className={styles.weekName}>{label(w.index)}</span>
                  </th>
                  <td title={w.catchup ? `${w.catchup} catch-up pepper${w.catchup === 1 ? '' : 's'} excluded (a position missed earlier)` : undefined}>
                    {p ? formatTwoDecimals(p.perM2) : <span className={styles.missingText}>—</span>}
                  </td>
                  {p ? (
                    <>
                      <td>{formatCount(p.set)}</td>
                      <td>{formatCount(p.harvested)}</td>
                      <td>{formatCount(p.lost)}</td>
                      <td>{formatCount(p.onPlant)}</td>
                      <td className={styles.experimental} title={survivalTitle(p)}>
                        {formatCount(p.furtherLosses)}
                      </td>
                      <td className={styles.experimental} title={survivalTitle(p)}>
                        {formatCount(p.expectedHarvest)}
                      </td>
                      <td className={`${styles.kg} ${styles.experimental}`}>{p.eventualKg === null ? <span className={styles.missingText}>AFW needed</span> : formatCount(p.eventualKg)}</td>
                      <td className={styles.byWeekCell}>
                        {[...p.byWeek]
                          .map(([t, v]) => `${label(t)}${t === origin + 1 ? ' (next week)' : ''} ${v.kg === null ? '—' : formatCount(v.kg)}`)
                          .join(' · ') || <span className={styles.dash}>nothing left to harvest</span>}
                        {w.inProgress && <span className={styles.missingText}> · {WEEK_STATUS.in_progress}</span>}
                        {w.status === 'possible_catchup' && <span className={styles.missingText}> · possible catch-up, included at your request</span>}
                      </td>
                    </>
                  ) : (
                    <td colSpan={8}>
                      <span className={styles.missingText}>{WEEK_STATUS[w.status]}</span>
                    </td>
                  )}
                </tr>
              )
            })}
            {shownWeeks.length === 0 && (
              <tr>
                <td colSpan={10}>
                  <span className={styles.missingText}>No sampled week with new Sets yet.</span>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <h3 className={styles.subTitle}>By harvest week: kg from recorded Sets</h3>
      <div className={styles.historyWrap}>
        <table className={`${styles.table} ${styles.historyTable}`}>
          <thead>
            <tr>
              <th scope="col">Week</th>
              <th scope="col" title="What the week's figure rests on. Breakers and Sets are never added together.">Basis</th>
              <th scope="col">Peppers</th>
              <th scope="col">AFW g</th>
              <th scope="col">Kg</th>
              <th scope="col">Cases</th>
              <th scope="col" title="Share of a typical week's harvest whose set weeks have usable Sets; below 100% the estimate has incomplete coverage">Sets coverage</th>
            </tr>
          </thead>
          <tbody>
            {[...outlook].reverse().map((w) => (
              <tr key={w.targetIndex}>
                <th scope="row">
                  <span className={styles.weekName}>{label(w.targetIndex)}</span>
                </th>
                <td className={styles.sourceCell}>{w.coverage > 0 ? 'Sets-based · estimated' : <span className={styles.missingText}>No recorded Sets yet</span>}</td>
                <td className={styles.experimental}>{w.coverage > 0 ? formatCount(w.fruit) : '—'}</td>
                <td title={w.afwSource ?? undefined}>{w.afwG === null ? '—' : w.afwG.toFixed(0)}</td>
                <td className={`${styles.kg} ${styles.experimental}`}>{w.coverage > 0 ? (w.kg === null ? <span className={styles.missingText}>AFW needed</span> : formatCount(w.kg)) : '—'}</td>
                <td className={styles.experimental}>{w.coverage > 0 && w.kg !== null && caseWeight ? formatCount(w.kg / caseWeight) : '—'}</td>
                <td>
                  {pct(w.coverage)}
                  {w.coverage > 0 && w.coverage < 0.995 && <span className={styles.missingText}> · Incomplete coverage</span>}
                </td>
              </tr>
            ))}
            <tr className={styles.currentRow}>
              <th scope="row">
                <span className={styles.weekName}>{label(origin + 1)}</span>
              </th>
              <td
                className={styles.sourceCell}
                title={`Next week is the official Breakers forecast (Ready % applies to it only). Sets-based harvest due next week: ${formatCount(dueNextWeek.kg)} kg, shown for reference and never added to it.`}
              >
                Breakers-based{nextSource ? ` · ${nextSource}` : <span className={styles.missingText}> · no forecast yet</span>}
                {dueNextWeek.fruit > 0 && <span className={styles.dash}> · Sets-based {formatCount(dueNextWeek.kg)} kg, not added</span>}
              </td>
              <td>{formatCount(next?.cropFruit ?? null)}</td>
              <td>{next?.afwG != null ? next.afwG.toFixed(0) : '—'}</td>
              <td className={styles.kg}>{formatCount(next?.kg ?? null)}</td>
              <td>{formatCount(next?.cases ?? null)}</td>
              <td>
                <span className={styles.dash}>—</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p className={styles.fate}>
        Fruit set = new Sets/m² × {formatCount(Number(crop.area_m2))} m². Expected harvest = harvested so far + peppers still on the plant × the chance they are
        harvested; eventual kg at each harvest week’s AFW. Each pepper is counted in one week only; ages above {MAX_AGE} weeks aren’t followed. Plants’ own
        observations only. Recalculated on this page; never saved, and not used by the official forecast or Production Totals.
      </p>
    </div>
  )
}
