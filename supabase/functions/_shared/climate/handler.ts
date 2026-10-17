// The `climate` Edge Function's HTTP contract, independent of Deno and of the
// database client (both injected), so it can be tested directly.
//
//   GET  …/api/v1/climate/ping      agent key → { organization_name, key_label, source_name, server_time }
//   POST …/api/v1/climate/imports   agent key; JSON { filename, file_hash?, raw_csv_base64, agent_version?, readings? }
//   POST …/manual                   signed-in owner; multipart: source_id + files (several)
//   POST …/review                    signed-in owner; JSON { file_id, hour_utc, note }: a quarantined
//                                    file re-read from its stored bytes with the hour assigned
//
// A 2xx answer means the original bytes and the import's status are committed.
// Anything the server can't store answers 5xx so the agent keeps the file and
// retries. Responses never echo keys.

import { parseBlockSummary, type ParsedFile } from './blockSummary.ts'

export const MAX_FILE_BYTES = 1_048_576
export const MAX_MANUAL_FILES = 50

export type AgentAuth = {
  key_id: string
  organization_id: string
  source_id: string
  key_label: string
  source_name: string
  organization_name: string
}

export type IngestArgs = {
  sourceId: string
  channel: 'agent' | 'manual'
  agentKeyId: string | null
  userId: string | null
  filename: string
  rawBase64: string
  sha256: string
  agentVersion: string | null
  parsed: ParsedFile
}

export type IngestResult = {
  status: 'created' | 'duplicate' | 'conflict' | 'quarantined'
  import_id: string
  hour_utc: string | null
  hour_local: string | null
  readings?: number
  file_status: string
}

export type StoredFile = {
  id: string
  organization_id: string
  source_id: string
  original_filename: string
  hour_state: string
  bytes: Uint8Array
}

export type Deps = {
  authenticateAgent(key: string, ip: string | null): Promise<AgentAuth | null>
  /** The signed-in user behind a Supabase access token, or null. */
  userFromToken(token: string): Promise<{ id: string } | null>
  sourceTimeZone(sourceId: string): Promise<string | null>
  ingest(args: IngestArgs): Promise<IngestResult>
  isOwner(userId: string, organizationId: string): Promise<boolean>
  loadFile(fileId: string): Promise<StoredFile | null>
  resolveQuarantined(fileId: string, userId: string, parsed: ParsedFile, note: string): Promise<{ file_id: string; state: string; readings: number; hour_utc: string }>
  now(): Date
  allowedOrigins: string[]
  log(event: string, detail: Record<string, unknown>): void
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export function toBase64(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

export function fromBase64(b64: string): Uint8Array {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64) || b64.length % 4 !== 0) throw new HttpError(422, 'invalid_base64', 'raw_csv_base64 is not valid base64.')
  const s = atob(b64)
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
  return out
}

function bearer(req: Request): string | null {
  const h = req.headers.get('authorization') ?? ''
  const m = /^Bearer\s+(\S+)$/i.exec(h)
  return m ? m[1] : null
}

function clientIp(req: Request): string | null {
  return req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || null
}

function corsHeaders(req: Request, deps: Deps): Record<string, string> {
  const origin = req.headers.get('origin')
  if (!origin || !deps.allowedOrigins.includes(origin)) return {}
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-headers': 'authorization, content-type, apikey, x-client-info',
    'access-control-allow-methods': 'POST, OPTIONS',
    vary: 'Origin',
  }
}

function json(status: number, body: unknown, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra } })
}

const fileResult = (r: IngestResult, parsed: ParsedFile) => ({
  status: r.status,
  import_id: r.import_id,
  hour_utc: r.hour_utc,
  hour_local: r.hour_local,
  readings: r.readings ?? null,
  file_status: r.file_status,
  problems: parsed.problems.map((p) => p.code),
  warnings: parsed.warnings.map((p) => p.code),
})

async function ingestBytes(
  deps: Deps,
  bytes: Uint8Array,
  filename: string,
  ctx: { sourceId: string; channel: 'agent' | 'manual'; agentKeyId: string | null; userId: string | null; agentVersion: string | null; receivedAt?: Date },
) {
  if (bytes.length === 0) throw new HttpError(422, 'empty_file', 'The file is empty.')
  if (bytes.length > MAX_FILE_BYTES) throw new HttpError(413, 'file_too_large', `The file is larger than ${MAX_FILE_BYTES} bytes.`)
  const sha256 = await sha256Hex(bytes)
  const timeZone = (await deps.sourceTimeZone(ctx.sourceId)) ?? 'America/Toronto'
  const parsed = parseBlockSummary(bytes, filename, { timeZone, receivedAt: ctx.receivedAt })
  const result = await deps.ingest({
    sourceId: ctx.sourceId,
    channel: ctx.channel,
    agentKeyId: ctx.agentKeyId,
    userId: ctx.userId,
    filename,
    rawBase64: toBase64(bytes),
    sha256,
    agentVersion: ctx.agentVersion,
    parsed,
  })
  return { sha256, parsed, result }
}

const route = (path: string) =>
  path.endsWith('/api/v1/climate/ping')
    ? 'ping'
    : path.endsWith('/api/v1/climate/imports')
      ? 'imports'
      : path.endsWith('/manual')
        ? 'manual'
        : path.endsWith('/review')
          ? 'review'
          : null

export async function handle(req: Request, deps: Deps): Promise<Response> {
  const cors = corsHeaders(req, deps)
  try {
    const which = route(new URL(req.url).pathname)
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors })
    if (!which) throw new HttpError(404, 'not_found', 'Not found.')

    if (which === 'manual') return await manual(req, deps, cors)
    if (which === 'review') return await review(req, deps, cors)

    // Agent endpoints: the key decides the organization and source.
    const key = bearer(req)
    const auth = key ? await deps.authenticateAgent(key, clientIp(req)) : null
    if (!auth) throw new HttpError(401, 'unauthorized', 'Missing, revoked or expired upload key.')

    if (which === 'ping') {
      if (req.method !== 'GET') throw new HttpError(405, 'method_not_allowed', 'Use GET.')
      return json(200, { status: 'ok', organization_name: auth.organization_name, source_name: auth.source_name, key_label: auth.key_label, server_time: deps.now().toISOString() })
    }

    if (req.method !== 'POST') throw new HttpError(405, 'method_not_allowed', 'Use POST.')
    if (!(req.headers.get('content-type') ?? '').toLowerCase().includes('application/json')) throw new HttpError(415, 'unsupported_media_type', 'Send JSON.')
    const text = await req.text()
    if (text.length > 2 * MAX_FILE_BYTES) throw new HttpError(413, 'body_too_large', 'The request is too large.')
    let body: Record<string, unknown>
    try {
      body = JSON.parse(text)
    } catch {
      throw new HttpError(400, 'invalid_json', 'The body is not valid JSON.')
    }
    const filename = typeof body.filename === 'string' ? body.filename.trim() : ''
    if (!filename || filename.length > 255) throw new HttpError(422, 'invalid_filename', 'filename is required (at most 255 characters).')
    if (typeof body.raw_csv_base64 !== 'string' || body.raw_csv_base64 === '') {
      throw new HttpError(422, 'raw_csv_required', 'raw_csv_base64 (the original file) is required: update the agent.')
    }
    const bytes = fromBase64(body.raw_csv_base64)
    const agentVersion = typeof body.agent_version === 'string' ? body.agent_version.slice(0, 50) : null

    const { sha256, parsed, result } = await ingestBytes(deps, bytes, filename, {
      sourceId: auth.source_id,
      channel: 'agent',
      agentKeyId: auth.key_id,
      userId: null,
      agentVersion,
      receivedAt: deps.now(),
    })
    // The agent hashes the same bytes ("sha256-<hex>"); a mismatch is logged, not fatal: what was received is what is stored.
    const claimed = typeof body.file_hash === 'string' ? body.file_hash.replace(/^sha256-/, '').toLowerCase() : null
    if (claimed && claimed !== sha256) deps.log('hash_mismatch', { filename, claimed, sha256 })
    deps.log('ingest', { channel: 'agent', filename, status: result.status, import_id: result.import_id })
    return json(result.status === 'created' ? 201 : 200, fileResult(result, parsed))
  } catch (e) {
    if (e instanceof HttpError) return json(e.status, { status: 'error', error: e.code, message: e.message }, cors)
    deps.log('error', { message: e instanceof Error ? e.message : String(e) })
    // Not stored: the agent keeps the file and tries again later.
    return json(500, { status: 'error', error: 'server_error', message: 'The file was not stored; try again later.' }, cors)
  }
}

async function manual(req: Request, deps: Deps, cors: Record<string, string>): Promise<Response> {
  if (req.method !== 'POST') throw new HttpError(405, 'method_not_allowed', 'Use POST.')
  const token = bearer(req)
  const user = token ? await deps.userFromToken(token) : null
  if (!user) throw new HttpError(401, 'unauthorized', 'Sign in to import climate files.')
  let form: FormData
  try {
    form = await req.formData()
  } catch {
    throw new HttpError(415, 'unsupported_media_type', 'Send multipart/form-data.')
  }
  const sourceId = form.get('source_id')
  if (typeof sourceId !== 'string' || !/^[0-9a-f-]{36}$/i.test(sourceId)) throw new HttpError(422, 'invalid_source', 'source_id is required.')
  const files = form.getAll('files').filter((f): f is File => typeof f !== 'string')
  if (files.length === 0) throw new HttpError(422, 'no_files', 'Attach at least one file.')
  if (files.length > MAX_MANUAL_FILES) throw new HttpError(413, 'too_many_files', `At most ${MAX_MANUAL_FILES} files per request.`)

  // Each file is stored in its own transaction; one failure doesn't undo the others.
  const results = []
  for (const f of files) {
    try {
      const bytes = new Uint8Array(await f.arrayBuffer())
      const { sha256, parsed, result } = await ingestBytes(deps, bytes, f.name, {
        sourceId,
        channel: 'manual',
        agentKeyId: null,
        userId: user.id,
        agentVersion: null,
      })
      results.push({ filename: f.name, sha256, ...fileResult(result, parsed) })
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      if (/owner|42501/i.test(message)) throw new HttpError(403, 'forbidden', 'Only an organization owner can import climate files.')
      results.push({ filename: f.name, status: 'error', error: e instanceof HttpError ? e.code : 'not_stored', message: e instanceof HttpError ? e.message : 'Not stored; try this file again.' })
      if (!(e instanceof HttpError)) deps.log('error', { filename: f.name, message })
    }
  }
  deps.log('ingest', { channel: 'manual', user: user.id, files: results.length })
  return json(200, { status: 'ok', results }, cors)
}

async function review(req: Request, deps: Deps, cors: Record<string, string>): Promise<Response> {
  if (req.method !== 'POST') throw new HttpError(405, 'method_not_allowed', 'Use POST.')
  const token = bearer(req)
  const user = token ? await deps.userFromToken(token) : null
  if (!user) throw new HttpError(401, 'unauthorized', 'Sign in to review climate imports.')
  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    throw new HttpError(400, 'invalid_json', 'The body is not valid JSON.')
  }
  const fileId = typeof body.file_id === 'string' && /^[0-9a-f-]{36}$/i.test(body.file_id) ? body.file_id : null
  const hourUtc = typeof body.hour_utc === 'string' ? body.hour_utc : null
  const note = typeof body.note === 'string' ? body.note.trim() : ''
  if (!fileId || !hourUtc) throw new HttpError(422, 'invalid_request', 'file_id and hour_utc are required.')
  if (!note) throw new HttpError(422, 'note_required', 'A note explaining the decision is required.')
  const t = Date.parse(hourUtc)
  if (!Number.isFinite(t) || t % 3_600_000 !== 0) throw new HttpError(422, 'invalid_hour', 'hour_utc must be a whole hour.')

  const file = await deps.loadFile(fileId)
  // Same answer for a missing file and someone else's: nothing about it is revealed.
  if (!file || !(await deps.isOwner(user.id, file.organization_id))) throw new HttpError(403, 'forbidden', 'Only an organization owner can review this file.')
  if (file.hour_state !== 'none') throw new HttpError(409, 'not_quarantined', 'This file is not quarantined.')

  const timeZone = (await deps.sourceTimeZone(file.source_id)) ?? 'America/Toronto'
  const parsed = parseBlockSummary(file.bytes, file.original_filename, { timeZone, hourOverrideUtc: new Date(t).toISOString() })
  if (parsed.status !== 'parsed') {
    return json(422, { status: 'error', error: 'still_unreadable', message: 'The file can\'t be read even with an assigned hour.', problems: parsed.problems }, cors)
  }
  const r = await deps.resolveQuarantined(file.id, user.id, parsed, note)
  deps.log('review', { file_id: file.id, user: user.id, state: r.state })
  return json(200, { status: 'resolved', ...r, hour_local: parsed.time.hourLocal, warnings: parsed.warnings.map((w) => w.code) }, cors)
}
