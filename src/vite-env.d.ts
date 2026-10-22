/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL?: string
  readonly VITE_SUPABASE_ANON_KEY?: string
  /** "off" hides camera-first Breaker recording (photos already queued still upload). */
  readonly VITE_BREAKER_PHOTOS?: string
  /** "off" hides the Harvestable button and labels (marks already recorded stay stored). */
  readonly VITE_HARVESTABLE?: string
  /** "on" shows the post-harvest workflow (Harvests page, inspections on the phone). Off by default until the real-phone test passes. */
  readonly VITE_POST_HARVEST_INSPECTIONS?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
