// Read-only check of a folder of Ridder Synopta Block Summary exports before
// importing them (e.g. the climate PC's Uploaded\YYYY-MM and Failed folders).
// Nothing is uploaded or changed. Uses the same parser as the climate import.
//
//   node --experimental-strip-types scripts/climate-preflight.ts <folder> [known-sha256.txt] [report.csv]
//
// known-sha256.txt: one SHA-256 per line of files already imported (from
// production, read-only). Real exports never go into the repository.

import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { parseBlockSummary } from '../supabase/functions/_shared/climate/blockSummary.ts'

const [folder, knownPath, reportPath] = process.argv.slice(2)
if (!folder) {
  console.error('usage: climate-preflight.ts <folder> [known-sha256.txt] [report.csv]')
  process.exit(2)
}
const walk = (d: string): string[] =>
  readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : f.toLowerCase().endsWith('.csv') ? [join(d, f)] : []))
const known = new Set(knownPath ? readFileSync(knownPath, 'utf8').split(/\s+/).filter(Boolean) : [])

type Row = { path: string; sha256: string; status: string; hourLocal: string; codes: string; known: boolean }
const rows: Row[] = []
for (const path of walk(folder).sort()) {
  const bytes = readFileSync(path)
  const p = parseBlockSummary(new Uint8Array(bytes), basename(path), { timeZone: 'America/Toronto' })
  rows.push({
    path,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    status: p.status,
    hourLocal: p.time.hourLocal ?? p.time.filenameLocal ?? '',
    codes: [...p.problems, ...p.warnings].map((x) => x.code).join(' '),
    known: false,
  })
}
for (const r of rows) r.known = known.has(r.sha256)

const bySha = new Map<string, number>()
for (const r of rows) bySha.set(r.sha256, (bySha.get(r.sha256) ?? 0) + 1)
const byHour = new Map<string, Set<string>>()
for (const r of rows.filter((x) => x.status === 'parsed')) byHour.set(r.hourLocal, (byHour.get(r.hourLocal) ?? new Set()).add(r.sha256))
const hours = [...byHour.keys()].sort()
const count = (f: (r: Row) => boolean) => rows.filter(f).length
const codes = new Map<string, number>()
for (const r of rows) for (const c of r.codes.split(' ').filter(Boolean)) codes.set(c, (codes.get(c) ?? 0) + 1)

console.log(`files: ${rows.length}`)
console.log(`  readable (would be imported or recognised): ${count((r) => r.status === 'parsed')}`)
console.log(`  would be held for review: ${count((r) => r.status === 'quarantined')}`)
console.log(`  already in production (same bytes): ${count((r) => r.known)}`)
console.log(`  exact copies within the folder: ${[...bySha.values()].filter((n) => n > 1).reduce((s, n) => s + n - 1, 0)}`)
console.log(`  hours with two different files: ${[...byHour.values()].filter((s) => s.size > 1).length}`)
if (hours.length) {
  const first = Date.parse(hours[0].replace(' ', 'T') + 'Z'), last = Date.parse(hours[hours.length - 1].replace(' ', 'T') + 'Z')
  const expected = Math.round((last - first) / 3_600_000) + 1
  console.log(`  hours covered: ${hours.length} of ${expected} between ${hours[0].slice(0, 16)} and ${hours[hours.length - 1].slice(0, 16)} (local)`)
}
console.log(`  problem / warning codes: ${[...codes.entries()].map(([c, n]) => `${c} ${n}`).join(', ') || 'none'}`)
if (reportPath) {
  writeFileSync(reportPath, 'path,sha256,status,hour_local,codes,already_in_production\n' + rows.map((r) => [r.path, r.sha256, r.status, r.hourLocal, r.codes, r.known].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n') + '\n')
  console.log(`report: ${reportPath}`)
}
