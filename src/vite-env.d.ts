/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL?: string
  readonly VITE_SUPABASE_ANON_KEY?: string
  /** "off" hides camera-first Breaker recording (photos already queued still upload). */
  readonly VITE_BREAKER_PHOTOS?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
