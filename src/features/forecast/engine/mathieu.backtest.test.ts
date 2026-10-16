// Backtest on a real crop export. Skipped unless BACKTEST_DATA points at a
// JSON export (see the forecast README); writes its report to BACKTEST_OUT.
//
//   BACKTEST_DATA=…/mathieu.json BACKTEST_OUT=…/report.md npx vitest run src/features/forecast/engine/mathieu.backtest.test.ts

import { readFileSync, writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { forecastAfw } from './afw'
import { originCutoff, runBacktest, type BacktestData, type Candidate, type CandidateReport } from './backtest'
import { metrics, type Metrics } from './accuracy'
import { fitTransitions, stemLoad, tableFor } from './hazards'
import { buildHistory } from './history'
import { modelTiming, setToHarvestTiming } from './timing'
import { DEFAULT_PARAMS, FORECAST_WEEKS, type AfwMethod, type EngineFlag, type EngineInput } from './types'
import { weekIndex, weekLabel } from './weeks'

const DATA = process.env.BACKTEST_DATA
const OUT = process.env.BACKTEST_OUT

const NO_RECENCY = { SetFruit: Infinity, MatureGreen: Infinity, BreakerFruit: Infinity }
const CANDIDATES: Candidate[] = [
  { id: 'stage', label: 'Stage model (fruit load)', kind: 'model', params: {} },
  { id: 'stage-noload', label: 'Stage model, no fruit load', kind: 'model', params: { loadBands: 0 } },
  { id: 'stage-flat', label: 'Stage model, no recency weighting', kind: 'model', params: { halfLifeWeeks: NO_RECENCY } },
  { id: 'stage-side', label: 'Stage model, side shoots separate', kind: 'model', params: { splitSideShoots: true } },
  { id: 'stage-confirmed', label: 'Stage model, harvest flags confirmed', kind: 'model', params: { assumeConfirmed: ['harvest_not_recorded'] } },
  { id: 'stage-fast', label: 'Sensitivity: set-fruit memory 3 weeks', kind: 'model', params: { halfLifeWeeks: { SetFruit: 3, MatureGreen: 8, BreakerFruit: 12 } } },
  { id: 'cohort', label: 'Cohort ladder (+N %)', kind: 'baseline', baseline: 'cohortLadder' },
  { id: 'mean3', label: 'Mean of last 3 weeks', kind: 'baseline', baseline: 'mean3' },
  { id: 'last', label: 'Last week repeated', kind: 'baseline', baseline: 'lastWeek' },
]

type RawExport = Omit<EngineInput, 'flags'> & { finalFlags: EngineFlag[]; flagsAsOf: Record<string, EngineFlag[]> }

function load(path: string): BacktestData {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as RawExport
  const input = {
    crop: { ...raw.crop, pickingStems: Number(raw.crop.pickingStems), areaM2: Number(raw.crop.areaM2) },
    stems: raw.stems,
    nodes: raw.nodes,
    observations: raw.observations,
    growth: raw.growth,
    stemVisits: raw.stemVisits,
    afw: raw.afw.map((a) => ({ ...a, afwG: Number(a.afwG) })),
  }
  const flagsAsOf = new Map(Object.entries(raw.flagsAsOf).map(([w, flags]) => [weekIndex(2026, Number(w)), flags]))
  return {
    input,
    flagsAsOf,
    finalFlags: raw.finalFlags,
    origins: Array.from({ length: 11 }, (_, i) => weekIndex(2026, 29 + i)), // W29 … W39
    lastScoreable: weekIndex(2026, 40), // W41 is a 5-of-56-stem partial visit with no visit after it
  }
}

const pct = (x: number | null) => (x === null ? '—' : `${(100 * x).toFixed(0)}%`)
const sgn = (x: number | null) => (x === null ? '—' : `${x >= 0 ? '+' : ''}${(100 * x).toFixed(0)}%`)
const cell = (m: Metrics) => (m.n === 0 ? '—' : `${pct(m.wape)} / ${sgn(m.bias)} (${m.n})`)

function timingSection(data: BacktestData): string[] {
  const lines: string[] = []
  const last = data.lastScoreable
  const input = { ...data.input, flags: data.finalFlags }
  const history = buildHistory(input, last, originCutoff(last))
  const periods: [string, number | undefined, number | undefined][] = [
    ['All set weeks', undefined, undefined],
    ['Set W22–W27', weekIndex(2026, 22), weekIndex(2026, 27)],
    ['Set W28–W31', weekIndex(2026, 28), weekIndex(2026, 31)],
    ['Set W32–W36', weekIndex(2026, 32), weekIndex(2026, 36)],
  ]
  lines.push('### Set → harvest timing (life table; data to W40, right-censored fruit kept at risk)', '')
  lines.push('Cumulative share of set fruit harvested by each age (weeks since first recorded as fruit); · = no fruit observed that old yet. Aborted / pruned / unresolved: by the oldest age observed.', '')
  lines.push('| Set weeks | Fruit | By +4 | +5 | +6 | +7 | +8 | +9 | +10 | +12 | +14 | Aborted | Pruned | Unresolved | Median harvest age | Still on plant at last record (censored) | Event after a missed week |')
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|')
  for (const [label, from, to] of periods) {
    const t = setToHarvestTiming(history, { maxAge: 14, setFrom: from, setTo: to })
    const oldest = t.rows.reduce((m, row) => (row.atRisk > 0 ? row.age : m), 0)
    const at = (age: number) => (age > oldest ? '·' : pct(t.rows[age - 1].cumHarvested))
    const end = t.rows[Math.max(oldest, 1) - 1]
    lines.push(`| ${label} | ${t.fruit} | ${at(4)} | ${at(5)} | ${at(6)} | ${at(7)} | ${at(8)} | ${at(9)} | ${at(10)} | ${at(12)} | ${at(14)} | ${pct(end.cumAborted)} | ${pct(end.cumPruned)} | ${pct(end.stillOnPlant)} | ${t.medianHarvestAge === null ? '—' : `+${t.medianHarvestAge}`} | ${t.rightCensored} | ${t.intervalCensored} |`)
  }
  lines.push('')
  // The model's timing for a pepper set now, as fitted at different origins (crop-average load).
  lines.push('### Model: harvest probability by age for a pepper set in the origin week', '')
  lines.push('| Fitted at | +4 | +5 | +6 | +7 | +8 | +9 | +10 | Harvested by +8 | by +14 | Most likely week |', '|---|---|---|---|---|---|---|---|---|---|---|')
  for (const w of [30, 34, 38, 40]) {
    const o = weekIndex(2026, w)
    const h = buildHistory({ ...data.input, flags: data.flagsAsOf.get(o) ?? [] }, o, originCutoff(o))
    const model = fitTransitions(h, DEFAULT_PARAMS)
    const loadOf = stemLoad(h)
    const meanLoad = h.sampleStemIds.reduce((a, st) => a + loadOf(st, o), 0) / h.sampleStemIds.length
    const p = modelTiming(tableFor(model, false, meanLoad), 14)
    const cum = (n: number) => p.slice(0, n).reduce((a, b) => a + b, 0)
    lines.push(`| W${w} (load ${meanLoad.toFixed(1)}) | ${[4, 5, 6, 7, 8, 9, 10].map((a) => pct(p[a - 1])).join(' | ')} | ${pct(cum(8))} | ${pct(cum(14))} | +${p.indexOf(Math.max(...p)) + 1} |`)
  }
  lines.push('')
  return lines
}

function report(data: BacktestData, result: ReturnType<typeof runBacktest>): string {
  const lines: string[] = []
  const r = result.reports
  const head = Array.from({ length: FORECAST_WEEKS }, (_, k) => `+${k + 1}`)
  lines.push('**Historical replay on unverified records — not validated accuracy.** Mathieu 2026 was recorded before explicit stem checks and contains known node-identity mistakes; these numbers show how the model behaves on that history, not how accurate it is.', '')
  lines.push(`Origins W29–W39; observed harvests scored to W40. Unreliable observed weeks (scored as 2-week blocks): ${result.unreliable.map((i) => weekLabel(i)).join(', ')}.`)
  lines.push('Cells: WAPE / bias (number of scored weeks or blocks). Weeks +6 … +8 are the outlook; few of them can be scored yet.', '')
  for (const [title, key, mk, all] of [
    ['Fruit count', 'fruitByHorizon', 'marketingFruit', 'allWeeksFruit'],
    ['Kilograms', 'kgByHorizon', 'marketingKg', 'allWeeksKg'],
  ] as const) {
    lines.push(`### ${title}`, '', `| Model | ${head.join(' | ')} | Weeks 1–5 total | Weeks 1–8 total |`, `|---|${head.map(() => '---|').join('')}---|---|`)
    for (const c of r) lines.push(`| ${c.candidate.label} | ${c[key].map(cell).join(' | ')} | ${cell(c[mk])} | ${cell(c[all])} |`)
    lines.push('')
  }
  lines.push('### Forecast AFW vs entered AFW: mean absolute % error (bias)', '', '| Method | +1 | +3 | +5 | +8 |', '|---|---|---|---|---|')
  const afwOf = new Map(data.input.afw.map((a) => [weekIndex(a.year, a.week), a.afwG]))
  for (const method of ['last', 'mean3', 'trend6'] as AfwMethod[]) {
    const row = [1, 3, 5, 8].map((h) => {
      const pairs = data.origins
        .map((o) => ({ f: forecastAfw(data.input.afw, o, o + h, method)?.grams, a: afwOf.get(o + h) }))
        .filter((p): p is { f: number; a: number } => p.f !== undefined && p.a !== undefined)
      if (pairs.length === 0) return '—'
      const m = metrics(pairs.map((p) => ({ forecast: p.f, observed: p.a })))
      const mape = pairs.reduce((a, p) => a + Math.abs(p.f / p.a - 1), 0) / pairs.length
      return `${(100 * mape).toFixed(1)}% (${sgn(m.bias)})`
    })
    lines.push(`| ${method} | ${row.join(' | ')} |`)
  }
  lines.push('')
  lines.push(...timingSection(data))
  const main = r.find((c) => c.candidate.id === 'stage')!
  lines.push('### Stage model, week by week (sample peppers: forecast → observed; * unreliable week; · not scoreable yet)', '', `| Origin | ${head.join(' | ')} |`, `|---|${head.map(() => '---|').join('')}`)
  for (const o of main.origins) {
    lines.push(`| ${weekLabel(o.originIndex)} | ${o.weeks.map((w) => `${weekLabel(w.index)} ${w.forecastFruit.toFixed(0)} → ${w.index <= data.lastScoreable ? w.observedFruit : '·'}${result.unreliable.includes(w.index) ? '*' : ''}`).join(' | ')} |`)
  }
  return lines.join('\n')
}

describe.skipIf(!DATA)('backtest on a real crop', () => {
  it('runs every candidate from W29 to W39 over eight weeks', { timeout: 300_000 }, () => {
    const data = load(DATA!)
    const result = runBacktest(data, CANDIDATES)
    const text = report(data, result)
    if (OUT) {
      writeFileSync(OUT, text)
      writeFileSync(OUT.replace(/\.md$/, '.json'), JSON.stringify(result.reports.map((c: CandidateReport) => ({ id: c.candidate.id, fruitByHorizon: c.fruitByHorizon, kgByHorizon: c.kgByHorizon, marketingFruit: c.marketingFruit, marketingKg: c.marketingKg, allWeeksFruit: c.allWeeksFruit, allWeeksKg: c.allWeeksKg, origins: c.origins })), null, 1))
    }
    expect(result.reports).toHaveLength(CANDIDATES.length)
  })
})
