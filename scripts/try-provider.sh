#!/usr/bin/env bash
# Interactive helper to test real provider connections against the dev server.
#
# Prereqs:
#   docker compose -d db         (Postgres 18 on :5433)
#   cd apps/server && npx tsx --env-file=.env src/index.ts
#
# Usage:
#   ./scripts/try-provider.sh register [email]      # create a user, prints TOKEN
#   ./scripts/try-provider.sh omron AR you@mail.com 'acct-pass'
#   ./scripts/try-provider.sh igpsport username 'acct-pass'
#   ./scripts/try-provider.sh sync <connection_id>
#   ./scripts/try-provider.sh status <connection_id>
#   ./scripts/try-provider.sh revoke <connection_id>
set -euo pipefail

BASE="${STRIDASH_URL:-http://localhost:3000/api}"
EMAIL="${STRIDASH_EMAIL:-tom@example.com}"
PASS="${STRIDASH_PASSWORD:-supersecret1}"
BIG=""

req() { curl -s -w '\n[%{http_code}]\n' "$@"; }

auth() {
  BIG=$(req -X POST "$BASE/auth/login" -H "Content-Type: application/json" \
    -d "{\"email\":\"$EMAIL\",\"password\":\"$PASS\"}" \
    | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d.split('\n[')[0]).accessToken)}catch{console.log('')}})")
  if [ -z "$BIG" ]; then
    echo "login failed — register first: $0 register [email]"; exit 1
  fi
}

case "${1:-}" in
  register)
    REMAIL="${2:-$EMAIL}"
    req -X POST "$BASE/auth/register" -H "Content-Type: application/json" \
      -d "{\"email\":\"$REMAIL\",\"password\":\"$PASS\",\"displayName\":\"Me\"}" | head -5
    echo "then export: STRIDASH_EMAIL=$REMAIL"
    ;;
  omron)
    auth
    echo "connecting Omron (${2}, ${3})…"
    req -X POST "$BASE/connections" -H "Authorization: Bearer $BIG" -H "Content-Type: application/json" \
      -d "{\"provider\":\"OMRON\",\"email\":\"$3\",\"password\":\"$4\",\"country\":\"$2\"}" | head -20
    ;;
  igpsport)
    auth
    echo "connecting iGPSPORT intl (${2})…"
    req -X POST "$BASE/connections" -H "Authorization: Bearer $BIG" -H "Content-Type: application/json" \
      -d "{\"provider\":\"IGPSPORT\",\"username\":\"$2\",\"password\":\"$3\",\"region\":\"intl\"}" | head -20
    ;;
  sync)
    auth
    echo "syncing $2… (first sync pulls history; can take a moment)"
    req -X POST "$BASE/connections/$2/sync" -H "Authorization: Bearer $BIG" | head -30
    ;;
  status)
    auth
    req "$BASE/connections" -H "Authorization: Bearer $BIG" | head -5
    ;;
  syncs)
    auth
    req "$BASE/connections/$2/syncs" -H "Authorization: Bearer $BIG" | head -30
    ;;
  measurements)
    auth
    req "$BASE/measurements" -H "Authorization: Bearer $BIG" | head -60
    ;;
  activities)
    auth
    req "$BASE/activities" -H "Authorization: Bearer $BIG" | head -60
    ;;
  revoke)
    auth
    req -X DELETE "$BASE/connections/$2" -H "Authorization: Bearer $BIG"
    ;;
  *)
    echo "usage: $0 {register [email]|omron COUNTRY email pass|igpsport user pass|sync CONN|status|syncs CONN|measurements|activities|revoke CONN}"
    ;;
esac
