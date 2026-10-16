# Recovery procedure: forecasting rollout (migrations 20261020–20261024)

Applied to production on 2026-10-16 at 19:46 UTC, with the web app and the
`plants-forecast-worker` service deployed from `main` 13834d3. The migrations
only add tables, columns and functions. They change no existing row; a
rehearsal on a full production copy and the live before/after fingerprints
confirmed every existing table identical. Weekly Plant Data now counts sampled
stems from visit evidence (Mathieu W31 56 → 55, W41 28 → 5).

Work from the least to the most drastic step. Never delete observations or photos.

## 1. Stop automatic locking (seconds, nothing lost)

    railway down --service plants-forecast-worker --environment production

Locked forecasts stay. Queued lock jobs wait; restart with `railway up` of the
worker package (scripts/worker-railway/README.md).

## 2. Roll the web app back (minutes, nothing lost)

Deploy the photo release (main d37aa21) from a clean checkout:

    git worktree add --detach /tmp/plants-d37aa21 d37aa21
    railway up /tmp/plants-d37aa21 --path-as-root --service plants-web --environment production

It works with the new schema (it doesn't use the new tables). Phones keep
anything queued and send it when the app loads.

## 3. Hide forecasting from users without schema changes

Roll back the web app (2) and stop the worker (1). The new tables stay empty or
keep what was entered; nothing reads them.

## 4. Restore data (only for actual data loss)

- Records: the CSV export taken right before the migrations
  (`~/Projects/plants-backups/2026-10-16/production_before_forecasting_migrations/`,
  verified restorable), plus anything recorded since (export again first).
- Whole database: Supabase daily backups (Dashboard → Database → Backups;
  point-in-time recovery is off, so a restore loses everything after the
  backup). Use only with the owner's decision.

## 5. Removing the forecasting schema

Not provided as a script: once Friday walkthroughs, stem checks, actual kg and
locked forecasts exist, dropping the tables would delete them. If it is ever
needed, export the new tables first (forecast_basis_settings,
weekly_harvest_actuals, stem_visits, sampling_week_events, data_quality_reviews,
forecast_runs, forecast_run_weeks, forecast_lock_jobs, weekly_harvest_afw_log)
and restore the previous definitions of weekly_plant_data(), weekly_fruit_loss(),
set_harvest_cohorts() and crop_quality_flags() from migrations 20261017 and
earlier.
