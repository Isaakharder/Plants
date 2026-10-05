# Plants

Commercial greenhouse pepper crop projection.

| Page            | Question it answers               |
| --------------- | --------------------------------- |
| **Settings**    | What am I growing?                |
| **Plants**      | What's physically on the plants?  |
| **Projections** | What am I going to harvest?       |

Current scope: app foundation, variety (crop) setup, and the mobile greenhouse collector
(`/mobile`). Plants and Projections are placeholders.

## Stack

React + TypeScript + Vite · Supabase (Postgres, Auth, RLS) · TanStack Query · React Router · Zod · Railway

The browser talks directly to Supabase using the public anon key. All data access is
enforced by Row Level Security in Postgres. There is no custom backend yet; add one
(e.g. `server/`) when we need server-side jobs such as projections or imports.

## Getting started

```bash
npm install
cp .env.example .env.local        # fill in your Supabase URL and anon key
npx supabase login
npx supabase link --project-ref <ref>
npx supabase db push              # applies supabase/migrations
npm run dev
```

On first sign-in you'll be asked to name your greenhouse; this creates your organization.

Scripts: `dev`, `build`, `start` (serves `dist/`), `test`, `typecheck`, `lint`.

## Deploying to Railway

1. Create a service from this repo. `railway.json` sets the build and start commands.
2. Add service variables `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`. Vite inlines them at
   **build** time, so redeploy after changing them.
3. In Supabase → Authentication → URL Configuration, add the Railway domain as the Site URL.

Never put the Supabase `service_role` key in a `VITE_` variable or anywhere in this frontend.

## Data model

```
organizations ─┬─ organization_members ── auth.users
               └─ crops ── measurement_rows ── measurement_stems ─┬─ plant_nodes ── node_observations
                                                                  └─ stem_growth_measurements
```

- **A crop is one specific planting**, not a variety name. "Cadalora 2025" and "Cadalora 2026" are
  separate rows with separate IDs. Future observations, projections and harvests will reference `crops.id`.
  The UI calls these "Varieties".
- **Every business table has `organization_id`** and RLS policies based on `is_org_member()`.
  Copy that pattern for new tables.
- **Status is derived, not stored**: Planned (before planting date), Active (planting through pullout
  date inclusive), Finished (after pullout). See `src/features/crops/model.ts`.
- **Crops can be deleted** by any member of the organization (after a confirmation), **unless the
  collector has recorded data for them**: `measurement_rows.crop_id` is `ON DELETE RESTRICT`, so
  observations are never deleted along with a variety.
- **Dates are `date` columns** (no time zone) and are handled as `YYYY-MM-DD` strings in the
  frontend. Use `src/lib/dates.ts`; never `new Date('2025-12-08')`.

- **Collector tables carry `organization_id` and `crop_id`** on every level, with composite foreign
  keys that force them to match the parent's (a stem can't point at another crop's row or another
  organization's data). IDs are generated in the browser, so retried inserts are no-ops.
- **`node_observations` is append-only history**: one row per status a worker recorded, stamped with
  the greenhouse ISO week and the device time (`observed_at`). A node's status for a week is its
  latest observation that week; `node_latest_statuses` (view) is its latest overall. Projections can
  derive each fruit's set → breaker → harvest history from it. No projection logic exists yet.
- **`stem_growth_measurements`** holds one vegetative-growth reading (cm) per stem per week.

Schema changes go in a new file in `supabase/migrations/`. After changing the schema, regenerate types:
`npx supabase gen types typescript --linked > src/lib/database.types.ts`.

## Mobile collector (`/mobile`)

The greenhouse data-entry screens from CropLink, rebuilt on Plants' data layer. Open `/mobile` on a
phone (or install it: the manifest's start URL is `/mobile`). Routes: `/mobile`, `/mobile/measurements`
(alias), `/mobile/row/:rowId`. They sit inside the auth/organization gate but outside the desktop
layout. Varieties shown are the organization's **active** crops (between planting and pullout dates).

- **Writes** (row, stem, node, status, veg growth, node removal) all go through an IndexedDB queue
  (`collector/offline/offlineQueue.ts`) first, online or not, then sync in the order they were made.
  Network failures leave them queued; rejected writes stay as "failed" (shown in the banner, retried
  with *Sync now*), never discarded. Writes replay only under the session of the user who made them.
- **Reads** are direct Supabase queries under RLS. The collector's data and the organization are saved
  to IndexedDB (`collector/offline/queryPersistence.ts`) and restored at startup; queued writes are
  merged in on top. The home page also pre-loads every active row so it's on the device before the
  Wi-Fi drops.
- **Offline start**: the service worker (`public/sw.js`, production builds only) serves the app shell.
  If the access token expired while offline, the saved session is used until it can be refreshed
  (`features/auth/AuthProvider.tsx`). After such a refresh fails, supabase-js waits up to a minute
  before retrying, so syncing can lag a reconnect by up to a minute.
- **Weeks**: greenhouse ISO week in `America/Toronto`, from `collector/greenhouseWeek.ts` only. It is
  computed when each observation is saved, never cached from page load.
- **Styles**: `collector/collector.css` is scoped under `.collector-app`; it must not style anything
  outside it.

Schema and RLS checks (run in a rolled-back transaction, leave nothing behind):
`npx supabase db query --linked -f supabase/tests/collector_rls_test.sql`.

## Projections › Weekly Plant Data

`/projections/weekly-plant-data`: per ISO week of a variety's year, Sets/m², Breakers/m² and
Harvested/m² observed on the sampled plants. Calculated in one request by the database function
`weekly_plant_data(crop, year)` (security invoker, so RLS applies). Rules, in that migration:
each stage counts once per node, in the first week it was recorded there (latest observation per
node-week; no inferred stages); sampled stems = stems whose first-to-last observed span covers the
week; sampled m² = stems ÷ (picking stems ÷ area). The first sampled week is flagged *Baseline*, the
current greenhouse week *In progress*, and unsampled weeks show —.

The **+0 … +10** cohort ladder and **Loss** column come from `set_harvest_cohorts(crop, year)` (one
row per harvest week, cells nested). Every pepper starts its own clock in the week it is first
recorded SetFruit (+0); cell +N on row H is the share of the cohort set in week H − N that was first
recorded Harvested at exactly +N, so each cohort runs diagonally down the table. A first Harvested
record at +1 … +10 is a cohort harvest; a pepper not harvested by the end of its +10 week is outside
the window (+11 or later) and resolves as Aborted, Pruned or Timeout for cohort analysis (its raw
observations are unchanged and a later Harvested record still counts in Harvested/m²). Once a cohort's
+10 week has passed (and was sampled), the row where its ladder ends shows its Loss = Aborted + Pruned
+ Timeout, and harvested + loss = 100%; open cohorts keep their still-on-plant fruit. Each row
reconciles raw Harvested = harvested within window + harvested without SetFruit + harvested after the
window. A cell is — when there is no cohort or the week wasn't sampled, 0% for an observed zero;
cells from the baseline cohort are styled as uncertain. Clicking a week's Sets/m² highlights its
ladder. The table starts at the first sampled week, hides cohort ages with no harvest in the displayed
weeks (presentation only; cells keep their real ages), and scrolls inside its own box with a frozen
header row and Week column. All per-node rules live in `crop_node_weeks(crop)` / `crop_node_stages(crop)`.
Tests: `npx supabase db query --linked -f supabase/tests/<file>.sql` for `weekly_plant_data_test.sql`
and `set_harvest_cohorts_test.sql`.

## Structure

```
src/
  app/            App shell: providers, routes, layout/navigation, auth gate
  components/     Shared UI (PageHeader, Dialog, empty/loading states)
  features/
    auth/         Session + sign-in
    organization/ Current organization + onboarding
    crops/        Varieties: model, validation, data hooks, cards, form, detail page
    collector/    Mobile greenhouse collector (/mobile): pages, scoped CSS, offline queue and cache
    projections/  Projections subtabs (Weekly Plant Data)
  pages/          Top-level route pages (Projections, Plants, Settings)
  lib/            Supabase client, DB types, date/number helpers
  styles/         Design tokens + global styles
supabase/
  migrations/     SQL schema (source of truth)
  tests/          SQL checks for RLS and constraints
```
