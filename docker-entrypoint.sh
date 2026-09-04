#!/bin/sh
set -e

# Migrations are idempotent, so running them on every boot is safe and keeps a
# deploy to a single step.
echo "[boot] applying database migrations"
node dist-scripts/migrate.cjs

# A self-hosted deployment has no external cron, so the container runs its own
# ticker. It is a plain HTTP client for the same worker endpoint a cron job
# would call — the queue lives in Postgres either way, so this process holds no
# state and can be restarted at any moment.
if [ "$RUN_INTERNAL_WORKER" = "true" ]; then
  echo "[boot] starting internal worker ticker"
  node dist-scripts/worker-loop.cjs &
fi

echo "[boot] starting web server"
exec node server.js
