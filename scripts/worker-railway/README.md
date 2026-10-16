# Forecast lock worker (Railway service)

Locks the official Friday forecast on the server once a week's sampling is
marked complete, every sampled stem is checked and the checks have synced
(`forecast_lock_readiness()` = ready). Runs as its own Railway service, never
in the web app.

Build the deploy folder from a clean checkout of `main`:

    npm ci && npm run build:worker     # → dist-worker/ (bundle + railway.json + package.json)
    railway up dist-worker --path-as-root --service plants-forecast-worker --environment production

Service variables (Railway → service → Variables; never in a `VITE_` variable,
never in the repository):

- `SUPABASE_URL`: the project URL
- `SUPABASE_SERVICE_ROLE_KEY`: the service-role key (bypasses RLS: server only)
- `WORKER_INTERVAL_MS` (optional): polling interval, default 30000
