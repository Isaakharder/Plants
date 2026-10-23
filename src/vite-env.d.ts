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
  /** "on" shows "Forgot password?" and the reset page. Off by default until reset emails are delivered (custom SMTP). */
  readonly VITE_PASSWORD_RESET?: string
  /** "on" shows the experimental multi-week Sets outlook on Harvest Forecast (recalculated, never saved). Off by default until validated. */
  readonly VITE_SETS_OUTLOOK?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
