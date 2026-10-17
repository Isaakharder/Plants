// Edge Function `climate`: receives Ridder Synopta Block Summary exports from
// the GrowLinkAgent (upload key) and from manual imports (signed-in owner).
// See ../_shared/climate/handler.ts for the contract.
//
// Deployed without JWT verification (the agent has no Supabase session): every
// route authenticates itself. The service-role key is provided by Supabase to
// the function's environment and never leaves the server.

import { createClient } from 'npm:@supabase/supabase-js@2.117.2'
import { handle, type Deps, type IngestResult } from '../_shared/climate/handler.ts'

const url = Deno.env.get('SUPABASE_URL')!
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const db = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })

const allowedOrigins = (Deno.env.get('CLIMATE_ALLOWED_ORIGINS') ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

const timeZones = new Map<string, string>()

const deps: Deps = {
  async authenticateAgent(key, ip) {
    const { data, error } = await db.rpc('climate_agent_authenticate', { p_key: key, p_ip: ip })
    if (error) throw new Error(error.message)
    return data ?? null
  },
  async userFromToken(token) {
    const { data, error } = await db.auth.getUser(token)
    return error || !data.user ? null : { id: data.user.id }
  },
  async sourceTimeZone(sourceId) {
    if (!timeZones.has(sourceId)) {
      const { data, error } = await db.from('climate_sources').select('time_zone').eq('id', sourceId).maybeSingle()
      if (error) throw new Error(error.message)
      if (!data) return null
      timeZones.set(sourceId, data.time_zone)
    }
    return timeZones.get(sourceId)!
  },
  async ingest(a) {
    const { data, error } = await db.rpc('climate_ingest_file', {
      p_source_id: a.sourceId,
      p_channel: a.channel,
      p_agent_key_id: a.agentKeyId,
      p_user_id: a.userId,
      p_filename: a.filename,
      p_raw_base64: a.rawBase64,
      p_sha256: a.sha256,
      p_agent_version: a.agentVersion,
      p_parsed: a.parsed,
    })
    if (error) throw new Error(`${error.code ?? ''} ${error.message}`.trim())
    return data as IngestResult
  },
  async isOwner(userId, organizationId) {
    const { data, error } = await db.rpc('climate_user_is_owner', { p_user_id: userId, p_organization_id: organizationId })
    if (error) throw new Error(error.message)
    return data === true
  },
  async loadFile(fileId) {
    const { data, error } = await db
      .from('climate_import_files')
      .select('id, organization_id, source_id, original_filename, hour_state, raw_bytes')
      .eq('id', fileId)
      .maybeSingle()
    if (error) throw new Error(error.message)
    if (!data) return null
    // bytea arrives as \x followed by hex.
    const hex = String(data.raw_bytes).replace(/^\\x/, '')
    const bytes = new Uint8Array(hex.length / 2)
    for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16)
    return { ...data, bytes }
  },
  async resolveQuarantined(fileId, userId, parsed, note) {
    const { data, error } = await db.rpc('climate_resolve_quarantined_file', { p_file_id: fileId, p_user_id: userId, p_parsed: parsed, p_note: note })
    if (error) throw new Error(`${error.code ?? ''} ${error.message}`.trim())
    return data
  },
  now: () => new Date(),
  allowedOrigins,
  log(event, detail) {
    console.log(JSON.stringify({ event, ...detail }))
  },
}

Deno.serve((req) => handle(req, deps))
