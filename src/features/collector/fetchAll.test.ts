import { describe, expect, it } from 'vitest'
import { IncompleteReadError, fetchAll, type PageQuery } from './fetchAll'

type Rec = { id: string }
const ids = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `id-${String(i).padStart(5, '0')}` }))

/** Serves `records` (sorted by id) with keyset paging, capped at maxRows per request. */
function server(records: Rec[], maxRows: number, tweak?: (page: Rec[], call: number) => Rec[]) {
  let calls = 0
  const page: PageQuery<Rec> = async (after, limit, withCount) => {
    calls++
    let rows = records.filter((r) => after === null || r.id > after).slice(0, Math.min(limit, maxRows))
    if (tweak) rows = tweak(rows, calls)
    return { data: rows, error: null, status: 200, count: withCount ? records.length : null }
  }
  return { page, calls: () => calls }
}

describe('fetchAll', () => {
  it('reads past the 1,000-record cap until the exact count is reached', async () => {
    const s = server(ids(2500), 1000)
    const all = await fetchAll(s.page, (r) => r.id)
    expect(all).toHaveLength(2500)
    expect(s.calls()).toBe(3)
  })

  it('does not make an extra request when the last page is full', async () => {
    const s = server(ids(2000), 1000)
    expect(await fetchAll(s.page, (r) => r.id)).toHaveLength(2000)
    expect(s.calls()).toBe(2)
  })

  it('drops a record that appears on two pages', async () => {
    const records = ids(1500)
    // Page 2 repeats the last record of page 1.
    const s = server(records, 1000, (rows, call) => (call === 2 ? [records[999], ...rows] : rows))
    const all = await fetchAll(s.page, (r) => r.id)
    expect(all).toHaveLength(1500)
    expect(new Set(all.map((r) => r.id)).size).toBe(1500)
  })

  it('throws instead of returning fewer records than exist', async () => {
    // A server that stops after one page, whatever the cursor says.
    const s = server(ids(1500), 1000, (rows, call) => (call > 1 ? [] : rows))
    await expect(fetchAll(s.page, (r) => r.id)).rejects.toBeInstanceOf(IncompleteReadError)
  })

  it('throws on a request error', async () => {
    const page: PageQuery<Rec> = async () => ({ data: null, error: { message: 'boom' }, status: 500, count: null })
    await expect(fetchAll(page, (r) => r.id)).rejects.toMatchObject({ message: 'boom', status: 500 })
  })

  it('refuses to loop when a page does not move past the previous one', async () => {
    const stuck: PageQuery<Rec> = async () => ({ data: [{ id: 'a' }], error: null, status: 200, count: 5 })
    await expect(fetchAll(stuck, (r) => r.id)).rejects.toThrow(/did not advance/)
  })

  it('handles an empty result', async () => {
    expect(await fetchAll(server([], 1000).page, (r) => r.id)).toEqual([])
  })
})
