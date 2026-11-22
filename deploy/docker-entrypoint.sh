#!/bin/sh
set -eu

cd /app/apps/server

# Migrations are safe to run on every start; Prisma records applied migrations.
# Compose waits for the database health check before this container starts.
echo "[entrypoint] applying database migrations"
/app/node_modules/.bin/prisma migrate deploy

echo "[entrypoint] starting Stridash"
exec /app/node_modules/.bin/tsx src/index.ts
