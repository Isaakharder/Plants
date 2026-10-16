// Runs the forecast lock worker in a loop (local development, or any Node host).
//
//   SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… node dist-worker/forecast-lock-worker.js
//
// Bundle first: npx rolldown -c scripts/rolldown.worker.config.mjs
// The service-role key bypasses RLS: keep it on the server, never in a VITE_ variable.

import { createClient } from '@supabase/supabase-js'
import type { Database } from '../src/lib/database.types'
import { processLockJobs } from '../src/features/forecast/server/lockWorker'

const url = process.env.SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
const everyMs = Number(process.env.WORKER_INTERVAL_MS ?? 30_000)
if (!url || !key) {
  console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.')
  process.exit(1)
}
const db = createClient<Database>(url, key, { auth: { persistSession: false, autoRefreshToken: false } })

async function round() {
  try {
    const r = await processLockJobs(db, { log: (m) => console.log(new Date().toISOString(), m) })
    if (r.locked || r.alreadyLocked || r.failed) console.log(new Date().toISOString(), 'round:', JSON.stringify(r))
  } catch (err) {
    console.error(new Date().toISOString(), 'round failed:', err instanceof Error ? err.message : err)
  }
}

console.log(`forecast lock worker: ${url}, every ${everyMs / 1000} s`)
await round()
setInterval(round, everyMs)
