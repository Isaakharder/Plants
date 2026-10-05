// A minimal stand-in for the Supabase/PostgREST query builder, for tests.
// Like the real server it caps every response at `maxRows` records, whatever
// limit the client asks for, and says nothing about having done so. Without
// an explicit order, rows come back in an arbitrary (shuffled) order.

type Row = Record<string, unknown>

export type FakeServer = {
  maxRows: number
  /** Number of requests per table, to show that reads were paginated. */
  requests: Record<string, number>
  /** Make the nth request (1-based) to a table fail like a dropped connection. */
  failRequest?: { table: string; nth: number }
}

const read = (row: Row, path: string): unknown =>
  path.split('.').reduce<unknown>((value, part) => (value as Row | null | undefined)?.[part], row)

class FakeQuery implements PromiseLike<unknown> {
  private filters: ((row: Row) => boolean)[] = []
  private orderBy: string | null = null
  private limitTo = Number.POSITIVE_INFINITY
  private withCount = false
  private single = false
  private table: string
  private rows: Row[]
  private server: FakeServer

  constructor(table: string, rows: Row[], server: FakeServer) {
    this.table = table
    this.rows = rows
    this.server = server
  }

  select(_columns: string, options?: { count?: 'exact' }) {
    this.withCount = options?.count === 'exact'
    return this
  }
  eq(column: string, value: unknown) {
    this.filters.push((row) => read(row, column) === value)
    return this
  }
  gt(column: string, value: string) {
    this.filters.push((row) => String(read(row, column)) > value)
    return this
  }
  order(column: string) {
    this.orderBy = column
    return this
  }
  limit(n: number) {
    this.limitTo = n
    return this
  }
  maybeSingle() {
    this.single = true
    return this
  }

  then<A, B>(onFulfilled?: ((value: unknown) => A | PromiseLike<A>) | null, onRejected?: ((reason: unknown) => B | PromiseLike<B>) | null): PromiseLike<A | B> {
    return Promise.resolve(this.execute()).then(onFulfilled, onRejected)
  }

  private execute() {
    const n = (this.server.requests[this.table] = (this.server.requests[this.table] ?? 0) + 1)
    const fail = this.server.failRequest
    if (fail && fail.table === this.table && fail.nth === n) {
      return { data: null, error: { message: 'TypeError: Failed to fetch' }, status: 0, count: null }
    }
    let matching = this.rows.filter((row) => this.filters.every((f) => f(row)))
    const count = this.withCount ? matching.length : null
    if (this.orderBy) {
      const col = this.orderBy
      // Code-point order, which is how Postgres orders UUIDs.
      matching = [...matching].sort((a, b) => {
        const x = String(read(a, col))
        const y = String(read(b, col))
        return x < y ? -1 : x > y ? 1 : 0
      })
    }
    const page = matching.slice(0, Math.min(this.limitTo, this.server.maxRows))
    if (this.single) return { data: page[0] ?? null, error: null, status: 200, count }
    return { data: page, error: null, status: 200, count }
  }
}

/** A fake `supabase` client over in-memory tables. */
export function fakeSupabase(tables: Record<string, Row[]>, server: FakeServer) {
  return {
    from: (table: string) => new FakeQuery(table, tables[table] ?? [], server),
  }
}

/** Deterministic shuffle, so "no order requested" really means arbitrary order. */
export function shuffled<T>(items: T[], seed = 7): T[] {
  const out = [...items]
  let s = seed
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) % 2147483648
    const j = s % (i + 1)
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}
