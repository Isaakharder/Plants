import { createClient } from '@supabase/supabase-js'
import type { Database } from './database.types'

const url = import.meta.env.VITE_SUPABASE_URL
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

/** False when the build is missing its Supabase env vars. */
export const isSupabaseConfigured = Boolean(url && anonKey)

const baseUrl = url ?? 'http://localhost:54321'

/** localStorage key of the saved session (supabase-js's default, made explicit). */
export const authStorageKey = `sb-${new URL(baseUrl).hostname.split('.')[0]}-auth-token`

// Only the public anon key belongs here. Access is enforced by RLS in Postgres.
export const supabase = createClient<Database>(baseUrl, anonKey ?? 'missing-anon-key', {
  auth: { storageKey: authStorageKey },
})
