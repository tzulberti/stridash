#!/bin/sh
set -eu

# Run the production Compose stack with the Node version from .nvmrc.
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT"

NODE_VERSION=$(tr -d '[:space:]' < .nvmrc)
if [ -z "$NODE_VERSION" ]; then
  echo "Could not read the Node version from .nvmrc" >&2
  exit 1
fi
export NODE_VERSION

exec docker compose --env-file deploy/.env -f docker-compose.prod.yml "$@"
