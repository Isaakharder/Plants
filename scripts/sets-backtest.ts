// Backtest of the Sets production potential (src/features/forecast/engine/sets.ts)
// on an export of a local data copy (Plants observations only). Read-only;
// real data never goes into the repository, so the export path is an argument
// and results print to stdout.
//
// A. Each simulated estimate uses only what was known at its origin: cohorts
//    rebuilt from each pepper's set, harvest and loss weeks up to the origin
//    (later outcomes unknown: still on the plant) and Sets/m² of weeks up to
//    it. Compared with Plants' harvested/m² on the sampled stems and with the
//    average of the four weeks up to the origin.
// B. The estimates now, as the page shows them.
//
//   npx rolldown scripts/sets-backtest.ts -o <dir>/sets-backtest.mjs -p node && node <dir>/sets-backtest.mjs <export.json> <current-week>

import { readFileSync } from 'node:fs'
import type { PepperTypeRow, SamplingWeekRow, SetCohortOutcomeRow, WeeklyNewSetsRow } from '../src/lib/database.types'
import { MAX_AGE, setsPotential, type Cohort } from '../src/features/forecast/engine/sets'
import { weekIndex, weekLabel, ywIndex } from '../src/features/forecast/engine/weeks'
import { cohortsFrom, modelGroupFrom, setsWeeks } from '../src/features/forecast/setsInputs'

type Export = {
  crops: { name: string; area: number }[]
  /** Per crop: weekly_new_sets, sampling_weeks and set_cohort_outcomes rows (as the page loads them). */
  newSets: Record<string, WeeklyNewSetsRow[]>
  sampling: Record<string, SamplingWeekRow[]>
  outcomes: Record<string, SetCohortOutcomeRow[]>
  pd: { crop: string; week: number; harvm2: number | null }[]
  afw: { crop: string; week: number; afw: number }[]
  /** Per pepper (crop_node_stages): set, harvest and loss weeks (yw), first record week. */
  nodes: { crop: string; set: number | null; harv: number | null; loss: number | null; first: number }[]
  actuals: { crop: string; week: number; kg: number | null }[]
  /** Each variety's pepper type (its model group). */
  pepperTypes: Record<string, PepperTypeRow>
}

const data: Export = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const YEAR = 2026
const CURRENT_WEEK = Number(process.argv[3] ?? 43)
const idx = (week: number) => weekIndex(YEAR, week)
const label = (i: number) => weekLabel(i, YEAR)
const fmt = (v: number | null, d = 2) => (v === null || !Number.isFinite(v) ? '—' : v.toFixed(d))
const pct = (v: number | null) => (v === null || !Number.isFinite(v) ? '—' : `${(100 * v).toFixed(0)}%`)
const kgText = (v: number | null) => (v === null ? 'no AFW' : `${Math.round(v).toLocaleString('en-US')} kg`)
/** A variety's model group; refuses a variety without one (never a default type). */
const groupOf = (crop: string) => {
  const t = data.pepperTypes?.[crop]
  if (!t) throw new Error(`${crop}: no pepper type in the export`)
  return modelGroupFrom(t)
}
const afwOf = (crop: string) => data.afw.filter((a) => a.crop === crop).map((a) => ({ year: YEAR, week: a.week, afwG: Number(a.afw) }))

/** Cohorts as known at the origin: outcomes after it are unknown (still on the plant). */
function cohortsAt(crop: string, origin: number): Cohort[] {
  const baseline = Math.min(...data.nodes.filter((n) => n.crop === crop).map((n) => ywIndex(n.first)))
  const byWeek = new Map<number, Cohort>()
  for (const n of data.nodes) {
    if (n.crop !== crop || n.set === null) continue
    const set = ywIndex(n.set)
    if (set > origin) continue
    const c = byWeek.get(set) ?? { pepperTypeId: groupOf(crop).pepperTypeId, cropId: crop, setIndex: set, sets: 0, harvestedByAge: Array(MAX_AGE + 1).fill(0), lostByAge: Array(MAX_AGE + 1).fill(0), resolvedLater: 0, onPlant: 0, isBaseline: set === baseline }
    byWeek.set(set, c)
    c.sets++
    const harv = n.harv === null ? null : ywIndex(n.harv)
    const loss = n.loss === null ? null : ywIndex(n.loss)
    const resolved = harv !== null && harv <= origin ? { at: harv, harvested: true } : loss !== null && loss <= origin ? { at: loss, harvested: false } : null
    if (!resolved) c.onPlant++
    else if (resolved.at - set > MAX_AGE) c.resolvedLater++
    else (resolved.harvested ? c.harvestedByAge : c.lostByAge)[Math.max(0, resolved.at - set)]++
  }
  return [...byWeek.values()]
}

type Pair = { h: number; p: number; a: number; naive: number }
function score(pairs: Pair[], title: string) {
  console.log(`\n${title}`)
  console.log('lead  n   actual/m²  estimate error  bias   4-wk avg error  bias')
  for (const h of [...new Set(pairs.map((p) => p.h))].sort((a, b) => a - b)) {
    const ps = pairs.filter((p) => p.h === h)
    const a = ps.reduce((s, p) => s + p.a, 0)
    const e = (f: (p: Pair) => number) => ps.reduce((s, p) => s + f(p), 0) / a
    console.log(
      `${String(h).padStart(4)} ${String(ps.length).padStart(3)}   ${fmt(a / ps.length).padStart(7)}   ${pct(e((p) => Math.abs(p.p - p.a))).padStart(12)}  ${pct(e((p) => p.p - p.a)).padStart(5)}   ${pct(e((p) => Math.abs(p.naive - p.a))).padStart(12)}  ${pct(e((p) => p.naive - p.a)).padStart(5)}`,
    )
  }
  if (pairs.length === 0) console.log('  (no simulated estimates)')
}

/** Mathieu (the only variety with harvests to compare): estimates from each past origin against what was harvested. */
function backtest(crop: string, title: string, opts: { twoWeek?: boolean; forceProvisional?: boolean } = {}) {
  const complete = (w: number) => {
    const s = data.sampling[crop].find((r) => r.iso_week === w)
    return Boolean(s && s.expected_stems > 0 && s.visited_stems >= 0.9 * s.expected_stems)
  }
  const actual = new Map<number, number>()
  for (const r of data.pd) if (r.crop === crop && r.harvm2 !== null && complete(r.week)) actual.set(idx(r.week), Number(r.harvm2))
  const pairs: Pair[] = []
  for (let o = 28; o <= 41; o++) {
    const origin = idx(o)
    const past = [...actual].filter(([i]) => i <= origin && i > origin - 4).map(([, v]) => v)
    if (past.length < 4) continue
    const naive = past.reduce((s, v) => s + v, 0) / 4
    const r = setsPotential({
      cohorts: cohortsAt(crop, origin),
      sets: setsWeeks(data.newSets[crop], data.sampling[crop], YEAR, o + 1),
      originIndex: origin,
      areaM2: 1,
      afw: [],
      weeksAhead: 9,
      label,
      group: groupOf(crop),
      forceProvisional: opts.forceProvisional,
    })
    if (!opts.forceProvisional && r.parameters.survival?.kind !== 'measured') continue
    for (const w of r.outlook) {
      if (w.coverage < 0.9) continue
      const h = w.targetIndex - origin
      if (opts.twoWeek) {
        const next = r.outlook.find((x) => x.targetIndex === w.targetIndex + 1)
        const a1 = actual.get(w.targetIndex)
        const a2 = actual.get(w.targetIndex + 1)
        if (!next || next.coverage < 0.9 || a1 === undefined || a2 === undefined) continue
        pairs.push({ h, p: w.fruit + next.fruit, a: a1 + a2, naive: 2 * naive })
      } else {
        const a = actual.get(w.targetIndex)
        if (a !== undefined) pairs.push({ h, p: w.fruit, a, naive })
      }
    }
  }
  score(pairs, title)
}

console.log('Mathieu parameters as known at each origin (completed cohorts only):')
for (const o of [34, 38, 41, 43]) {
  const p = setsPotential({ cohorts: cohortsAt('Mathieu', idx(o)), sets: [], originIndex: idx(o), areaM2: 1, afw: [], weeksAhead: 1, label, group: groupOf('Mathieu') }).parameters
  const after = p.afterAge.map((x, a) => (x ? `${a}:${pct(x.survival)}` : '')).filter(Boolean).join(' ')
  console.log(`  W${o}: survival ${pct(p.survival?.value ?? null)} ${p.survival?.kind} (${p.survival?.basis})${after ? `\n        P(harvested | still on the plant at age): ${after}` : ''}`)
}
backtest('Mathieu', 'A. Mathieu, measured parameters, weekly harvested/m² (harvest weeks ≥90% covered by recorded Sets)')
backtest('Mathieu', 'A2. Same, two-week totals (Mathieu is picked every other week)', { twoWeek: true })
backtest('Mathieu', 'A3. Provisional assumptions on Mathieu (what the other varieties use now), each cohort conditioned on its own observations', { forceProvisional: true })
backtest('Mathieu', 'A4. Same, two-week totals', { forceProvisional: true, twoWeek: true })

for (const include of [false, true]) {
  console.log(`\nB${include ? '2' : ''}. Estimates now (origin = latest sampling week; current week W${CURRENT_WEEK}); possible catch-up weeks ${include ? 'INCLUDED' : 'left out (default)'}`)
  for (const { name, area } of data.crops) {
    const sampled = data.sampling[name].filter((s) => s.visited_stems > 0 && s.iso_week <= CURRENT_WEEK).at(-1)
    if (!sampled) continue
    const r = setsPotential({
      cohorts: cohortsFrom(data.outcomes[name], name, groupOf(name).pepperTypeId),
      group: groupOf(name),
      sets: setsWeeks(data.newSets[name], data.sampling[name], YEAR, CURRENT_WEEK),
      originIndex: idx(sampled.iso_week),
      areaM2: Number(area),
      afw: afwOf(name),
      weeksAhead: 9,
      label,
      includePossibleCatchup: include,
    })
    const { survival, timing } = r.parameters
    if (!survival || !timing) {
      console.log(`\n  ${name}: ${r.notConfigured}`)
      continue
    }
    const flagged = r.weeks.filter((w) => w.status === 'possible_catchup').map((w) => `${label(w.index)} (${pct(w.firstSeenShare)} first seen set)`)
    console.log(`\n  ${name} (from W${sampled.iso_week}): survival ${pct(survival.value)} ${survival.kind} · timing ${timing.kind}${flagged.length ? ` · possible catch-up: ${flagged.join(', ')}` : ''}`)
    for (const p of r.potential.slice(-4)) {
      console.log(
        `    set ${label(p.setIndex)}${p.status !== 'used' ? ` (${p.status})` : ''}: ${fmt(p.perM2)}/m² · set ${Math.round(p.set)} · harvested ${Math.round(p.harvested)} · lost ${Math.round(p.lost)} · on plant ${Math.round(p.onPlant)} → further losses ${Math.round(p.furtherLosses)} · expected harvest ${Math.round(p.expectedHarvest)} (${pct(p.stillOnPlantSurvival)} of on-plant, ${p.survivalBasis}) · eventual ${kgText(p.eventualKg)}`,
      )
    }
    if (r.dueNextWeek.fruit > 0) console.log(`    due next week (Breakers week, not added): ${kgText(r.dueNextWeek.kg)}`)
    for (const w of r.outlook.filter((x) => x.coverage > 0)) console.log(`    harvest ${label(w.targetIndex)}: ${kgText(w.kg)} · recorded Sets ${pct(w.coverage)}${w.coverage < 0.995 ? ' (incomplete coverage)' : ''}`)
    if (r.potential.length === 0) console.log('    no usable Sets week yet')
  }
}

console.log('\nC. Actual kg entered (in effect), as harvested peppers/m² (kg ÷ area ÷ that week’s AFW):')
for (const a of data.actuals.filter((x) => x.kg !== null)) {
  const area = Number(data.crops.find((c) => c.name === a.crop)!.area)
  const afw = data.afw.find((x) => x.crop === a.crop && x.week === a.week)?.afw
  console.log(`  ${a.crop} W${a.week}: ${a.kg} kg${afw ? ` = ${fmt(a.kg! / area / (Number(afw) / 1000))} peppers/m² at ${afw} g` : ''}`)
}
