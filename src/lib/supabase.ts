import { createClient } from '@supabase/supabase-js'
import type { Database } from './database.types'

const url = import.meta.env.VITE_SUPABASE_URL
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

/** False when the build is missing its Supabase env vars. */
export const isSupabaseConfigured = Boolean(url && anonKey)

// Only the public anon key belongs here. Access is enforced by RLS in Postgres.
export const supabase = createClient<Database>(
  url ?? 'http://localhost:54321',
  anonKey ?? 'missing-anon-key',
)
