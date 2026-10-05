// PostgREST returns at most `max_rows` records per request (1,000 on Supabase)
// and gives no sign that it stopped there. Every collector read that can grow
// with the data goes through fetchAll(), so a screen never works from a
// silently truncated list.

/** Records asked for per request. The server may return fewer (its max_rows). */
export const PAGE_SIZE = 1000

type PageResult<T> = {
  data: T[] | null
  error: { message: string } | null
  status: number
  count?: number | null
}

/**
 * One page of a query, ordered by the unique key column: records whose key is
 * greater than `after` (all when null), at most `limit` of them. `withCount`
 * asks for the exact total (sent on the first request only).
 */
export type PageQuery<T> = (after: string | null, limit: number, withCount: boolean) => PromiseLike<PageResult<T>>

/** The read returned fewer records than the server said exist. */
export class IncompleteReadError extends Error {}

/**
 * Reads every record of a query, page by page, with keyset pagination on a
 * unique column: each page starts after the last key of the previous one, so
 * pages can't overlap or skip records. Stops once the exact count taken on the
 * first request is reached (or a page comes back empty), and throws rather
 * than return fewer records than exist.
 */
export async function fetchAll<T>(page: PageQuery<T>, key: (record: T) => string): Promise<T[]> {
  const records: T[] = []
  const seen = new Set<string>()
  let after: string | null = null
  let expected: number | null = null

  for (;;) {
    const res = await page(after, PAGE_SIZE, expected === null)
    if (res.error) throw Object.assign(new Error(res.error.message), { status: res.status })
    if (expected === null) expected = res.count ?? Number.POSITIVE_INFINITY
    const rows = res.data ?? []
    if (rows.length === 0) break
    for (const row of rows) {
      const k = key(row)
      if (!seen.has(k)) {
        seen.add(k)
        records.push(row)
      }
    }
    const last = key(rows[rows.length - 1])
    if (after !== null && last <= after) throw new Error('Paginated read did not advance; refusing to loop.')
    after = last
    if (records.length >= expected) break
  }

  if (Number.isFinite(expected) && records.length < (expected ?? 0)) {
    throw new IncompleteReadError(`Loaded ${records.length} of ${expected} records. Try again.`)
  }
  return records
}
