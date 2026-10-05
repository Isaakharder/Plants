# Plants

Commercial greenhouse pepper crop projection.

| Page            | Question it answers               |
| --------------- | --------------------------------- |
| **Settings**    | What am I growing?                |
| **Plants**      | What's physically on the plants?  |
| **Projections** | What am I going to harvest?       |

Current scope: app foundation and variety (crop) setup. Plants and Projections are placeholders.

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
               └─ crops
```

- **A crop is one specific planting**, not a variety name. "Cadalora 2025" and "Cadalora 2026" are
  separate rows with separate IDs. Future observations, projections and harvests will reference `crops.id`.
  The UI calls these "Varieties".
- **Every business table has `organization_id`** and RLS policies based on `is_org_member()`.
  Copy that pattern for new tables.
- **Status is derived, not stored**: Planned (before planting date), Active (planting through pullout
  date inclusive), Finished (after pullout). See `src/features/crops/model.ts`.
- **Crops can be deleted** by any member of the organization (development-phase rule, after a
  confirmation). Revisit once Plants/Projections data references crops: block or restrict deletes then.
- **Dates are `date` columns** (no time zone) and are handled as `YYYY-MM-DD` strings in the
  frontend. Use `src/lib/dates.ts`; never `new Date('2025-12-08')`.

Schema changes go in a new file in `supabase/migrations/`. After changing the schema, regenerate types:
`npx supabase gen types typescript --linked > src/lib/database.types.ts`.

## Structure

```
src/
  app/            App shell: providers, routes, layout/navigation, auth gate
  components/     Shared UI (PageHeader, Dialog, empty/loading states)
  features/
    auth/         Session + sign-in
    organization/ Current organization + onboarding
    crops/        Varieties: model, validation, data hooks, cards, form, detail page
  pages/          Top-level route pages (Projections, Plants, Settings)
  lib/            Supabase client, DB types, date/number helpers
  styles/         Design tokens + global styles
supabase/
  migrations/     SQL schema (source of truth)
```
