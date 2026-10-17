import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { decodeExport, parseBlockSummary, systemDateCandidates } from './blockSummary.ts'

// Fixtures are synthetic (fictional values, real structure); see fixtures/generate.py.
// Real exports stay outside the repository; point CLIMATE_REAL_SAMPLES at them to test locally.
const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)))
const OCT17 = 'Block Summary_20261017_100009.csv'

/** The synthetic 17 Oct export with some rows replaced, re-encoded as Windows-1252 like the climate computer writes it. */
function variant(edit: (text: string) => string): Uint8Array {
  const text = edit(decodeExport(fixture(OCT17)).text)
  return Uint8Array.from([...text].map((ch) => (ch === '°' ? 0xb0 : ch === '²' ? 0xb2 : ch.charCodeAt(0))))
}
const withSystem = (date: string, time: string, week = '42') =>
  variant((t) =>
    t
      .replace('"Real time - 10:00"', `"Real time - ${time}"`)
      .replace('"10/17/2026"', `"${date}"`)
      .replace('"Week number","42"', `"Week number","${week}"`),
  )

describe('Block Summary parser: a 17 Oct 10:00 export (synthetic values, real structure)', () => {
  const p = parseBlockSummary(fixture(OCT17), OCT17)

  it('reads Windows-1252 and keeps every zone label exactly', () => {
    expect(p.encoding).toBe('windows-1252')
    expect(p.status).toBe('parsed')
    expect(p.problems).toEqual([])
    expect(p.warnings).toEqual([])
    expect(p.zones.map((z) => z.label)).toEqual(Array.from({ length: 22 }, (_, i) => `Zone ${i + 1}`))
    expect(p.meta.headerLabel).toBe('Block heating')
  })

  it('keeps every non-blank cell as an original reading, with exact labels, units and text', () => {
    const count = (metric: string) => p.readings.filter((r) => r.metric === metric).length
    expect(count('air_temperature')).toBe(22)
    expect(count('relative_humidity')).toBe(22)
    expect(count('co2')).toBe(22)
    expect(count('ec')).toBe(22)
    expect(count('ph')).toBe(22)
    expect(count('irrigation_cumulative')).toBe(22)
    // Reported only under Zones 1 and 15; nothing is copied to other zones.
    expect(p.readings.filter((r) => r.metric === 'radiation_sum').map((r) => [r.zone, r.raw_text])).toEqual([
      ['Zone 1', '96.5'],
      ['Zone 15', '96.5'],
    ])
    expect(p.readings.filter((r) => r.metric === 'drain_percentage').map((r) => r.zone)).toEqual(['Zone 1', 'Zone 15'])
    expect(p.readings).toHaveLength(22 * 6 + 2 + 2 + 2)
    const t1 = p.readings.find((r) => r.zone === 'Zone 1' && r.metric === 'air_temperature')!
    expect(t1).toEqual({ zone: 'Zone 1', row_label: 'Air temperature [°C]', metric: 'air_temperature', unit: '°C', unit_raw: '°C', raw_text: '22.4', value: 22.4, flags: [] })
    expect(p.readings.find((r) => r.metric === 'radiation_sum')!.row_label).toBe('Radiation sum [J/cm²]')
    expect(p.readings.find((r) => r.metric === 'irrigation_cumulative')!).toMatchObject({ unit: 'ml/dripper', unit_raw: 'ml/dripp', raw_text: '0' })
    expect(p.readings.find((r) => r.metric === 'group_activation_time')!).toMatchObject({ raw_text: 'Real time - --:--', value: null, flags: ['no_value'] })
  })

  it('flags zero pH, a zero EC and zero irrigation instead of accepting them silently', () => {
    expect(p.readings.filter((r) => r.metric === 'ph').every((r) => r.flags.includes('ph_zero_sentinel'))).toBe(true)
    expect(p.readings.filter((r) => r.flags.includes('ec_zero_suspect')).map((r) => r.zone)).toEqual(['Zone 7'])
    expect(p.readings.filter((r) => r.metric === 'irrigation_cumulative').every((r) => r.flags.includes('irrigation_zero'))).toBe(true)
    expect(p.readings.find((r) => r.zone === 'Zone 1' && r.metric === 'co2')!.flags).toEqual([])
  })

  it('takes the hour from the filename (Toronto, EDT) and checks it against the file’s System date and time', () => {
    expect(p.time).toMatchObject({
      filenameLocal: '2026-10-17 10:00:09',
      systemLocal: '2026-10-17 10:00:00',
      method: 'filename',
      hourLocal: '2026-10-17 10:00:00',
      hourUtc: '2026-10-17T14:00:00.000Z',
      dateOrder: 'MDY', // the header says dd/mm/yyyy, the value is month-first
      clockOffsetMinutes: 0,
    })
    expect(p.meta).toMatchObject({ systemDateRaw: '10/17/2026', systemTimeRaw: 'Real time - 10:00', weekNumberRaw: '42', sunriseRaw: 'Real time - 06:30' })
  })
})

describe('Block Summary parser: July exports (LF line endings, EDT)', () => {
  it.each([
    ['Block Summary_20260717_080003.csv', '2026-07-17T12:00:00.000Z'],
    ['Block Summary_20260717_090003.csv', '2026-07-17T13:00:00.000Z'],
    ['Block Summary_20260717_100005.csv', '2026-07-17T14:00:00.000Z'],
    ['Block Summary_20260717_110006.csv', '2026-07-17T15:00:00.000Z'],
  ])('%s → %s', (name, hourUtc) => {
    const p = parseBlockSummary(fixture(name), name)
    expect(p.status).toBe('parsed')
    expect(p.encoding).toBe('windows-1252')
    expect(p.time.hourUtc).toBe(hourUtc)
    expect(p.zones).toHaveLength(22)
    expect(p.warnings).toEqual([])
  })
})

describe('Block Summary parser: encoding and layout', () => {
  it('reads the same file saved as UTF-8 (with a byte-order mark) identically', () => {
    const text = decodeExport(fixture(OCT17)).text
    const utf8 = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(text)])
    const a = parseBlockSummary(fixture(OCT17), OCT17)
    const b = parseBlockSummary(utf8, OCT17)
    expect(b.encoding).toBe('utf-8')
    expect(b.readings).toEqual(a.readings)
  })

  it('keeps an unrecognised row as is, and notes an unexpected unit', () => {
    const p = parseBlockSummary(
      variant((t) => t.replace('"RH [%]"', '"RH [g/kg]"').replace('"Weather system"', '"Pipe temperature [°C]","45.5","","","","","","","","","","","","","","","","","","","","","","","",""\r\n"Weather system"')),
      OCT17,
    )
    expect(p.status).toBe('parsed')
    expect(p.warnings.map((w) => w.code).sort()).toEqual(['unexpected_unit', 'unrecognised_row'])
    expect(p.readings.find((r) => r.metric === 'unknown')).toMatchObject({ zone: 'Zone 1', row_label: 'Pipe temperature [°C]', raw_text: '45.5', value: 45.5, flags: ['unrecognised_row'] })
    expect(p.readings.find((r) => r.metric === 'relative_humidity')).toMatchObject({ unit: null, unit_raw: 'g/kg', flags: ['unexpected_unit'] })
  })

  it('quarantines a file without a zone header', () => {
    const p = parseBlockSummary(new TextEncoder().encode('"a","b"\r\n"1","2"\r\n'), OCT17)
    expect(p.status).toBe('quarantined')
    expect(p.problems.map((x) => x.code)).toContain('no_zone_header')
    expect(p.time.hourUtc).toBeNull()
  })

  it('quarantines a header that names a zone twice', () => {
    const p = parseBlockSummary(variant((t) => t.replace('"Zone 2","Zone 3"', '"Zone 2","Zone 2"')), OCT17)
    expect(p.problems.map((x) => x.code)).toEqual(['duplicate_zone_label'])
  })

  it('flags out-of-range and non-numeric values', () => {
    const p = parseBlockSummary(variant((t) => t.replace('"Air temperature [°C]","22.4"', '"Air temperature [°C]","85.0"').replace('"RH [%]","74"', '"RH [%]","n/a"')), OCT17)
    expect(p.readings.find((r) => r.zone === 'Zone 1' && r.metric === 'air_temperature')!.flags).toEqual(['out_of_range'])
    expect(p.readings.find((r) => r.zone === 'Zone 1' && r.metric === 'relative_humidity')).toMatchObject({ value: null, raw_text: 'n/a', flags: ['not_numeric'] })
  })
})

describe('Block Summary parser: dates, clocks and daylight saving', () => {
  it('reads the System date as month-first or day-first, whichever matches the filename', () => {
    expect(systemDateCandidates('10/5/2026').map((c) => c.order)).toEqual(['MDY', 'DMY'])
    expect(systemDateCandidates('10/17/2026').map((c) => c.order)).toEqual(['MDY'])
    expect(systemDateCandidates('10/10/2026').map((c) => c.order)).toEqual(['MDY'])
    const may = parseBlockSummary(withSystem('10/5/2026', '10:00', '19'), 'Block Summary_20260510_100004.csv')
    expect(may.time).toMatchObject({ dateOrder: 'DMY', hourUtc: '2026-05-10T14:00:00.000Z' })
    const oct = parseBlockSummary(withSystem('10/5/2026', '10:00', '41'), 'Block Summary_20261005_100004.csv')
    expect(oct.time).toMatchObject({ dateOrder: 'MDY', hourUtc: '2026-10-05T14:00:00.000Z' })
    const same = parseBlockSummary(withSystem('10/10/2026', '10:00', '41'), 'Block Summary_20261010_100004.csv')
    expect(same.time.dateOrder).toBe('either')
  })

  it('a clock a minute early or late still names the right hour, and the offset is kept', () => {
    const early = parseBlockSummary(withSystem('10/17/2026', '12:59'), 'Block Summary_20261017_130005.csv')
    expect(early.time).toMatchObject({ hourLocal: '2026-10-17 13:00:00', hourUtc: '2026-10-17T17:00:00.000Z', clockOffsetMinutes: -1 })
    const late = parseBlockSummary(withSystem('10/17/2026', '04:01'), 'Block Summary_20261017_040100.csv')
    expect(late.time).toMatchObject({ hourLocal: '2026-10-17 04:00:00', clockOffsetMinutes: 1 })
    expect(late.status).toBe('parsed')
  })

  it('a System time that disagrees with the filename is a warning; the filename decides', () => {
    const p = parseBlockSummary(withSystem('10/17/2026', '21:00'), OCT17)
    expect(p.status).toBe('parsed')
    expect(p.time.hourUtc).toBe('2026-10-17T14:00:00.000Z')
    expect(p.warnings.map((w) => w.code)).toEqual(['system_time_mismatch'])
  })

  it('a filename time far from the hour is quarantined, not guessed', () => {
    const p = parseBlockSummary(fixture(OCT17), 'Block Summary_20261017_102500.csv')
    expect(p.status).toBe('quarantined')
    expect(p.problems.map((x) => x.code)).toEqual(['filename_time_off_hour'])
  })

  it('without a timestamp in the filename, uses the System date/time when unambiguous', () => {
    const ok = parseBlockSummary(fixture(OCT17), '100009.csv')
    expect(ok.status).toBe('parsed')
    expect(ok.time).toMatchObject({ method: 'system', hourUtc: '2026-10-17T14:00:00.000Z' })
    expect(ok.warnings.map((w) => w.code)).toEqual(['time_from_system_clock'])
    const ambiguous = parseBlockSummary(withSystem('10/5/2026', '10:00'), '100009.csv')
    expect(ambiguous.status).toBe('quarantined')
    expect(ambiguous.problems.map((x) => x.code)).toEqual(['ambiguous_system_date'])
  })

  it('a wrong week number is a warning', () => {
    const p = parseBlockSummary(withSystem('10/17/2026', '10:00', '41'), OCT17)
    expect(p.warnings.map((w) => w.code)).toEqual(['week_number_mismatch'])
  })

  it('winter time (EST) is UTC−5', () => {
    const p = parseBlockSummary(withSystem('1/15/2027', '14:00', '2'), 'Block Summary_20270115_140002.csv')
    expect(p.time.hourUtc).toBe('2027-01-15T19:00:00.000Z')
  })

  it('the repeated autumn hour: placed by when the agent received it, otherwise quarantined for review', () => {
    const name = 'Block Summary_20261101_010004.csv'
    const file = withSystem('11/1/2026', '01:00', '44')
    const unknown = parseBlockSummary(file, name)
    expect(unknown.status).toBe('quarantined')
    expect(unknown.problems.map((x) => x.code)).toEqual(['repeated_hour_ambiguous'])
    expect(unknown.time.candidatesUtc).toEqual(['2026-11-01T05:00:00.000Z', '2026-11-01T06:00:00.000Z'])
    const first = parseBlockSummary(file, name, { receivedAt: new Date('2026-11-01T05:01:30Z') })
    expect(first.time.hourUtc).toBe('2026-11-01T05:00:00.000Z')
    expect(first.warnings.map((w) => w.code)).toEqual(['repeated_hour_resolved'])
    const second = parseBlockSummary(file, name, { receivedAt: new Date('2026-11-01T06:01:30Z') })
    expect(second.time.hourUtc).toBe('2026-11-01T06:00:00.000Z')
    // Arriving hours later (after an outage), it can't be told apart → review.
    const late = parseBlockSummary(file, name, { receivedAt: new Date('2026-11-01T08:30:00Z') })
    expect(late.status).toBe('quarantined')
    expect(late.problems.map((x) => x.code)).toEqual(['repeated_hour_ambiguous'])
  })

  it('the hour skipped in spring is quarantined', () => {
    const p = parseBlockSummary(withSystem('3/14/2027', '02:00', '10'), 'Block Summary_20270314_020005.csv')
    expect(p.status).toBe('quarantined')
    expect(p.problems.map((x) => x.code)).toEqual(['nonexistent_local_time'])
  })
})

const REAL = process.env.CLIMATE_REAL_SAMPLES
describe.skipIf(!REAL)('Block Summary parser: real exports (local only, never committed)', () => {
  const names = REAL ? readdirSync(REAL).filter((n) => n.toLowerCase().endsWith('.csv')) : []
  it.each(names)('%s', (name) => {
    const p = parseBlockSummary(new Uint8Array(readFileSync(join(REAL!, name))), name)
    expect(p.problems).toEqual([])
    expect(p.status).toBe('parsed')
    expect(p.zones.length).toBeGreaterThanOrEqual(2)
    expect(p.readings.length).toBeGreaterThan(0)
    expect(p.time.method).toBe('filename')
    expect(p.time.hourLocal!.slice(0, 13).replace(/[- ]/g, '')).toBe(name.match(/(\d{8})_(\d{2})/)!.slice(1).join(''))
  })
})
