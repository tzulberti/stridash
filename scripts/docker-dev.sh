#!/bin/sh
set -eu

# Run the Docker-only development stack with the Node version from .nvmrc.
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT"

NODE_VERSION=$(tr -d '[:space:]' < .nvmrc)
if [ -z "$NODE_VERSION" ]; then
  echo "Could not read the Node version from .nvmrc" >&2
  exit 1
fi
export NODE_VERSION

if [ "$#" -eq 0 ]; then
  set -- up --build
fi

exec docker compose -f docker-compose.dev.yml "$@"
