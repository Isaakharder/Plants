import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import type { ParsedFile } from './blockSummary.ts'
import { handle, sha256Hex, toBase64, type Deps, type IngestArgs, type IngestResult, type StoredFile } from './handler.ts'

const KEY = 'plk_0123456789_' + 'a'.repeat(64)
const FILE = 'Block Summary_20261017_100009.csv'
const bytes = new Uint8Array(readFileSync(new URL(`./fixtures/${FILE}`, import.meta.url)))
const BASE = 'https://example.supabase.co/functions/v1/climate'

function deps(over: Partial<Deps> = {}) {
  const ingested: IngestArgs[] = []
  const stored = new Map<string, IngestResult>()
  const d: Deps = {
    authenticateAgent: async (key) =>
      key === KEY ? { key_id: 'k1', organization_id: 'o1', source_id: 's1', key_label: 'Climate PC', source_name: 'Synopta', organization_name: 'First Light' } : null,
    userFromToken: async (token) => (token === 'user-jwt' ? { id: 'u1' } : null),
    sourceTimeZone: async () => 'America/Toronto',
    ingest: async (a) => {
      ingested.push(a)
      const prior = stored.get(a.sha256)
      if (prior) return { ...prior, status: 'duplicate' }
      const r: IngestResult = { status: a.parsed.status === 'parsed' ? 'created' : 'quarantined', import_id: `f${stored.size + 1}`, hour_utc: a.parsed.time.hourUtc, hour_local: a.parsed.time.hourLocal, readings: a.parsed.readings.length, file_status: 'active' }
      stored.set(a.sha256, r)
      return r
    },
    isOwner: async (userId, orgId) => userId === 'u1' && orgId === 'o1',
    loadFile: async () => null,
    resolveQuarantined: async () => {
      throw new Error('not expected')
    },
    now: () => new Date('2026-10-17T14:00:20Z'),
    allowedOrigins: ['https://plants.example'],
    log: () => {},
    ...over,
  }
  return { d, ingested }
}

const agentPost = (body: unknown, key = KEY, contentType = 'application/json') =>
  new Request(`${BASE}/api/v1/climate/imports`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': contentType },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })

describe('climate endpoint: agent', () => {
  it('ping: the key names its organization; a wrong key is refused', async () => {
    const { d } = deps()
    const ok = await handle(new Request(`${BASE}/api/v1/climate/ping`, { headers: { authorization: `Bearer ${KEY}` } }), d)
    expect(ok.status).toBe(200)
    expect(await ok.json()).toMatchObject({ organization_name: 'First Light', source_name: 'Synopta', key_label: 'Climate PC' })
    const bad = await handle(new Request(`${BASE}/api/v1/climate/ping`, { headers: { authorization: 'Bearer plk_nope' } }), d)
    expect(bad.status).toBe(401)
    const none = await handle(new Request(`${BASE}/api/v1/climate/ping`), d)
    expect(none.status).toBe(401)
  })

  it('stores the original bytes it received, parsed server-side, and answers 201', async () => {
    const { d, ingested } = deps()
    const res = await handle(agentPost({ filename: FILE, file_hash: 'sha256-' + (await sha256Hex(bytes)), raw_csv_base64: toBase64(bytes), agent_version: '2.0.0', readings: [] }), d)
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body).toMatchObject({ status: 'created', import_id: 'f1', hour_utc: '2026-10-17T14:00:00.000Z', hour_local: '2026-10-17 10:00:00', readings: 138 })
    expect(ingested[0]).toMatchObject({ sourceId: 's1', channel: 'agent', agentKeyId: 'k1', userId: null, filename: FILE, agentVersion: '2.0.0', sha256: await sha256Hex(bytes) })
    expect(ingested[0].rawBase64).toBe(toBase64(bytes))
    expect(ingested[0].parsed.encoding).toBe('windows-1252')
  })

  it('says which stored file an upload matched, and why (re-saved copy: same readings)', async () => {
    const matched = { file_id: 'f0', filename: 'Block Summary_20261017_100009.csv', received_at: '2026-10-17T14:01:00Z', hour_local: '2026-10-17 10:00:00', file_status: 'active', channel: 'manual' }
    const { d } = deps({ ingest: async () => ({ status: 'duplicate', reason: 'same_readings', matched, import_id: 'f0', hour_utc: '2026-10-17T14:00:00Z', hour_local: '2026-10-17 10:00:00', file_status: 'active' }) })
    const res = await handle(agentPost({ filename: FILE, raw_csv_base64: toBase64(bytes) }), d)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ status: 'duplicate', reason: 'same_readings', matched })
  })

  it('a copy of another hour is held (2xx: stored, the agent moves on) and reports why', async () => {
    const matched = { file_id: 'f0', filename: 'Block Summary_20261017_080003.csv', received_at: '2026-10-17T12:01:00Z', hour_local: '2026-10-17 08:00:00', file_status: 'active', channel: 'manual' }
    const { d } = deps({ ingest: async () => ({ status: 'quarantined', reason: 'same_readings_as_other_hour', matched, import_id: 'f9', hour_utc: null, hour_local: null, file_status: 'none' }) })
    const res = await handle(agentPost({ filename: FILE, raw_csv_base64: toBase64(bytes) }), d)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ status: 'quarantined', reason: 'same_readings_as_other_hour', problems: ['same_readings_as_other_hour'], matched })
  })

  it('a retry of the same file is a duplicate (200), so the agent can move it to Uploaded', async () => {
    const { d } = deps()
    const body = { filename: FILE, raw_csv_base64: toBase64(bytes) }
    expect((await handle(agentPost(body), d)).status).toBe(201)
    const again = await handle(agentPost(body), d)
    expect(again.status).toBe(200)
    expect(await again.json()).toMatchObject({ status: 'duplicate', import_id: 'f1' })
  })

  it('an unreadable file is still stored (quarantined) and acknowledged', async () => {
    const { d, ingested } = deps()
    const junk = new TextEncoder().encode('not a block summary')
    const res = await handle(agentPost({ filename: 'x.csv', raw_csv_base64: toBase64(junk) }), d)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ status: 'quarantined', problems: ['no_zone_header', 'no_timestamp'] })
    expect(ingested[0].rawBase64).toBe(toBase64(junk))
  })

  it('without the original file (today’s agent) the upload is refused: nothing is stored', async () => {
    const { d, ingested } = deps()
    const res = await handle(agentPost({ filename: FILE, file_hash: 'sha256-00', readings: [{ zone_label: 'Zone 1' }] }), d)
    expect(res.status).toBe(422)
    expect(await res.json()).toMatchObject({ error: 'raw_csv_required' })
    expect(ingested).toHaveLength(0)
  })

  it('a storage failure answers 500, so the agent keeps the file and retries', async () => {
    const { d } = deps({ ingest: vi.fn().mockRejectedValue(new Error('connection reset')) })
    const res = await handle(agentPost({ filename: FILE, raw_csv_base64: toBase64(bytes) }), d)
    expect(res.status).toBe(500)
    expect(await res.json()).toMatchObject({ error: 'server_error' })
  })

  it('refuses bad requests with 4xx and never echoes the key', async () => {
    const { d } = deps()
    expect((await handle(agentPost({ filename: FILE, raw_csv_base64: toBase64(bytes) }, 'plk_wrong'), d)).status).toBe(401)
    expect((await handle(agentPost('{"filename":', KEY), d)).status).toBe(400)
    expect((await handle(agentPost({ filename: FILE, raw_csv_base64: toBase64(bytes) }, KEY, 'text/csv'), d)).status).toBe(415)
    expect((await handle(agentPost({ filename: FILE, raw_csv_base64: 'not base64!' }), d)).status).toBe(422)
    expect((await handle(agentPost({ raw_csv_base64: toBase64(bytes) }), d)).status).toBe(422)
    const big = await handle(agentPost({ filename: FILE, raw_csv_base64: toBase64(new Uint8Array(1_048_577)) }), d)
    expect(big.status).toBe(413)
    const text = await (await handle(agentPost({ filename: FILE, raw_csv_base64: toBase64(bytes) }, 'plk_wrong'), d)).text()
    expect(text).not.toContain('plk_')
    expect((await handle(new Request(`${BASE}/api/v1/climate/imports`, { method: 'GET', headers: { authorization: `Bearer ${KEY}` } }), d)).status).toBe(405)
    expect((await handle(new Request(`${BASE}/elsewhere`), d)).status).toBe(404)
  })

  it('places the repeated autumn hour by the time the file arrived', async () => {
    const { d, ingested } = deps({ now: () => new Date('2026-11-01T06:00:40Z') })
    const text = new TextDecoder('windows-1252').decode(bytes).replace('10/17/2026', '11/1/2026').replace('Real time - 10:00', 'Real time - 01:00').replace('"Week number","42"', '"Week number","44"')
    const nov = Uint8Array.from([...text].map((c) => (c === '°' ? 0xb0 : c === '²' ? 0xb2 : c.charCodeAt(0))))
    const res = await handle(agentPost({ filename: 'Block Summary_20261101_010004.csv', raw_csv_base64: toBase64(nov) }), d)
    expect(await res.json()).toMatchObject({ status: 'created', hour_utc: '2026-11-01T06:00:00.000Z' })
    expect(ingested[0].parsed.warnings.map((w) => w.code)).toEqual(['repeated_hour_resolved'])
  })
})

describe('climate endpoint: manual import', () => {
  const form = (files: [string, Uint8Array][], sourceId = '6a0d2c1e-0000-4000-8000-000000000001') => {
    const f = new FormData()
    f.set('source_id', sourceId)
    for (const [name, b] of files) f.append('files', new File([b as BlobPart], name))
    return f
  }
  const post = (body: FormData, token = 'user-jwt', origin?: string) =>
    new Request(`${BASE}/manual`, { method: 'POST', headers: { authorization: `Bearer ${token}`, ...(origin ? { origin } : {}) }, body })

  it('imports several files, each on its own; a failing file doesn’t stop the others', async () => {
    let n = 0
    const ingested: IngestArgs[] = []
    const { d } = deps({
      ingest: async (a) => {
        ingested.push(a)
        n++
        if (n === 2) throw new Error('connection reset')
        return { status: 'created', import_id: `f${n}`, hour_utc: a.parsed.time.hourUtc, hour_local: a.parsed.time.hourLocal, readings: a.parsed.readings.length, file_status: 'active' }
      },
    })
    const july = new Uint8Array(readFileSync(new URL('./fixtures/Block Summary_20260717_080003.csv', import.meta.url)))
    const res = await handle(post(form([[FILE, bytes], ['Block Summary_20260717_090003.csv', july], ['Block Summary_20260717_080003.csv', july]])), d)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.results.map((r: { status: string }) => r.status)).toEqual(['created', 'error', 'created'])
    expect(body.results[1]).toMatchObject({ error: 'not_stored' })
    expect(ingested.every((a) => a.channel === 'manual' && a.userId === 'u1' && a.agentKeyId === null)).toBe(true)
    // Manual files carry no arrival time: the parse never uses one.
    expect(ingested[0].parsed.time.hourUtc).toBe('2026-10-17T14:00:00.000Z')
  })

  it('requires a signed-in owner', async () => {
    const { d } = deps()
    expect((await handle(post(form([[FILE, bytes]]), 'bad-jwt'), d)).status).toBe(401)
    const notOwner = deps({ ingest: vi.fn().mockRejectedValue(new Error('42501 Only an organization owner can import climate files')) })
    expect((await handle(post(form([[FILE, bytes]])), notOwner.d)).status).toBe(403)
  })

  it('answers the Plants web app’s origin (CORS) and no other', async () => {
    const { d } = deps()
    const pre = await handle(new Request(`${BASE}/manual`, { method: 'OPTIONS', headers: { origin: 'https://plants.example' } }), d)
    expect(pre.status).toBe(204)
    expect(pre.headers.get('access-control-allow-origin')).toBe('https://plants.example')
    const other = await handle(post(form([[FILE, bytes]]), 'user-jwt', 'https://evil.example'), d)
    expect(other.headers.get('access-control-allow-origin')).toBeNull()
  })
})

describe('climate endpoint: quarantine review', () => {
  // A file named without a timestamp whose System date reads both ways (10/5/2026): quarantined at upload.
  const text = new TextDecoder('windows-1252').decode(bytes).replace('10/17/2026', '10/5/2026')
  const ambiguous = Uint8Array.from([...text].map((c) => (c === '°' ? 0xb0 : c === '²' ? 0xb2 : c.charCodeAt(0))))
  const stored: StoredFile = { id: '6a0d2c1e-0000-4000-8000-0000000000f1', organization_id: 'o1', source_id: 's1', original_filename: '100009.csv', hour_state: 'none', bytes: ambiguous }
  const reviewPost = (body: unknown, token = 'user-jwt') =>
    new Request(`${BASE}/review`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })

  it('re-reads the stored bytes with the assigned hour and records the decision', async () => {
    const calls: { parsed: ParsedFile; note: string }[] = []
    const { d } = deps({
      loadFile: async (id) => (id === stored.id ? stored : null),
      resolveQuarantined: async (fileId, _u, parsed, note) => {
        calls.push({ parsed, note })
        return { file_id: fileId, state: 'active', readings: parsed.readings.length, hour_utc: parsed.time.hourUtc! }
      },
    })
    const res = await handle(reviewPost({ file_id: stored.id, hour_utc: '2026-10-05T14:00:00Z', note: 'Climate PC date is month-first' }), d)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ status: 'resolved', state: 'active', readings: 138, hour_local: '2026-10-05 10:00:00' })
    expect(calls[0].parsed.time.method).toBe('review')
    expect(calls[0].parsed.problems).toEqual([])
    expect(calls[0].note).toBe('Climate PC date is month-first')
  })

  it('requires an owner, a note and a whole hour; a non-quarantined file is refused', async () => {
    const { d } = deps({ loadFile: async () => stored })
    expect((await handle(reviewPost({ file_id: stored.id, hour_utc: '2026-10-05T14:00:00Z', note: 'x' }, 'bad-jwt'), d)).status).toBe(401)
    expect((await handle(reviewPost({ file_id: stored.id, hour_utc: '2026-10-05T14:00:00Z', note: ' ' }), d)).status).toBe(422)
    expect((await handle(reviewPost({ file_id: stored.id, hour_utc: '2026-10-05T14:30:00Z', note: 'x' }), d)).status).toBe(422)
    const other = deps({ loadFile: async () => ({ ...stored, organization_id: 'o2' }) })
    expect((await handle(reviewPost({ file_id: stored.id, hour_utc: '2026-10-05T14:00:00Z', note: 'x' }), other.d)).status).toBe(403)
    const missing = deps()
    expect((await handle(reviewPost({ file_id: stored.id, hour_utc: '2026-10-05T14:00:00Z', note: 'x' }), missing.d)).status).toBe(403)
    const active = deps({ loadFile: async () => ({ ...stored, hour_state: 'active' }) })
    expect((await handle(reviewPost({ file_id: stored.id, hour_utc: '2026-10-05T14:00:00Z', note: 'x' }), active.d)).status).toBe(409)
  })

  it('a file that can’t be read stays quarantined whatever the hour', async () => {
    const { d } = deps({ loadFile: async () => ({ ...stored, bytes: new TextEncoder().encode('not a block summary') }) })
    const res = await handle(reviewPost({ file_id: stored.id, hour_utc: '2026-10-05T14:00:00Z', note: 'try' }), d)
    expect(res.status).toBe(422)
    expect((await res.json()).problems.map((p: { code: string }) => p.code)).toEqual(['no_zone_header'])
  })
})
