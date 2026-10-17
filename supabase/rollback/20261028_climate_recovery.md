# Plants Climate: production deployment, verification and rollback

Release: `feature/plants-digital-twin` at the climate Stage 2 commit (on top of
production `main` 88e766a). Production gets exactly two migrations:
`20261027000000_climate_ingest` and `20261028000000_climate_review_and_monitoring`
(new tables, views and functions only; no existing object is altered).

## Deploy (each step only with approval)

1. **Fresh backup** (read-only):
   `~/Projects/plants-backups/scripts/export_production.sh ~/Projects/plants-backups/<date>-before-climate/deploy-export`
   then save fingerprints (`_fingerprints_at_export.csv`) and prove it:
   `restore_check.sh <export dir> <local shim dir> 20261026000000` → "RESTORE CHECK PASSED".
2. **Dry run** from a clean checkout of the release: `supabase db push --linked --dry-run`
   → exactly the two climate migrations.
3. **Migrate**: `supabase db push --linked`.
4. **Verify existing data**: recompute the fingerprints of the 24 existing tables → identical
   to the backup's.
5. **Edge Function**: `supabase functions deploy climate --use-api --no-verify-jwt --project-ref <prod ref>`;
   `supabase secrets set CLIMATE_ALLOWED_ORIGINS=https://plants-web-production-3469.up.railway.app`.
   Check: `GET …/functions/v1/climate/api/v1/climate/ping` without a key → 401.
6. **Web**: fast-forward `main` to the release; `railway up <clean checkout> --path-as-root
   --service plants-web --environment production --ci`. Check the site and the Climate menu.
7. **Set up** (owner, in the app): Settings › Climate › Set up climate data; create the agent key.
   Nothing reaches production climate tables until the agent is switched (separate approval).

## Rollback

| Problem | Action | Data |
|---|---|---|
| Web app | `railway up` a clean checkout of the previous `main` (88e766a) | none touched |
| Edge Function | `supabase functions delete climate --project-ref <prod ref>` (or redeploy the previous version) | none touched; the agent still sends to CropLink, or keeps files in its folder and retries |
| Schema | `supabase db query --linked -f supabase/rollback/20261028_climate_rollback.sql` — tested on a restored production copy: removes every climate object and the two history rows; all existing tables identical. **Deletes climate data**: export the climate tables first if any were received. | existing tables untouched |
| Existing data damaged (not expected: nothing writes to them) | restore from the backup's `*.jsonl.csv` copies table by table (see restore_check.sh for the exact load), or Supabase's daily physical backup | — |
| After the agent switch | switch the agent's Synopta URL and key back to CropLink; files sent to Plants in between stay in Plants and in the agent's Uploaded folder | — |
