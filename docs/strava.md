# Strava integration

Strava is Stridash's first **official** provider API (OAuth2 + documented REST
v3). It is also a useful backstop: Zwift and iGPSPORT can both push rides to
Strava, so one Strava account can surface activities recorded on either.

## OAuth setup

1. Create an API application at <https://www.strava.com/settings/api>.
2. Set the authorization callback domain to your Stridash host.
3. Configure the server:

   ```dotenv
   STRIDASH_PUBLIC_URL=https://stridash.example.com
   STRIDASH_STRAVA_CLIENT_ID=...
   STRIDASH_STRAVA_CLIENT_SECRET=...
   # optional; defaults to $STRIDASH_PUBLIC_URL/api/strava/callback
   STRIDASH_STRAVA_REDIRECT_URI=https://stridash.example.com/api/strava/callback
   STRIDASH_STRAVA_BACKFILL_DAYS=365
   ```

4. In the dashboard: **Connections → Connect Strava**. The browser goes to
   Strava's consent page and returns to `/connections?strava=connected`.

Scopes requested: `read,activity:read_all,profile:read_all` — private
activities and gear. Tokens are stored AES-256-GCM encrypted in
`connections.access_token_enc` / `refresh_token_enc`; the app never receives
them.

## Endpoints

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `GET` | `/api/strava/authorize` | app JWT | returns `{ url }` for the consent page |
| `GET` | `/api/strava/callback` | public + signed `state` | exchanges the code, stores the connection, redirects to `/connections` |
| `POST` | `/api/connections/:id/sync` | app JWT | queues a sync (same route as every provider) |
| `GET` | `/api/connections/:id/syncs` | app JWT | sync history |

The OAuth `state` is a 10-minute HS256 JWT containing the Stridash user id; the
callback verifies it before exchanging any code. No pending state is stored in
the database.

## Webhooks (near-real-time sync)

Strava can push activity create/update events instead of waiting for the
interval scheduler:

1. Set `STRIDASH_STRAVA_WEBHOOK_VERIFY_TOKEN` to a random string.
2. Create the subscription with the Strava API app credentials:

   ```bash
   curl -X POST https://www.strava.com/api/v3/push_subscriptions \
     -F client_id="$STRIDASH_STRAVA_CLIENT_ID" \
     -F client_secret="$STRIDASH_STRAVA_CLIENT_SECRET" \
     -F callback_url="https://stridash.example.com/api/strava/webhook" \
     -F verify_token="$STRIDASH_STRAVA_WEBHOOK_VERIFY_TOKEN"
   ```

3. Strava immediately calls `GET /api/strava/webhook` with
   `hub.mode=subscribe&hub.verify_token=…&hub.challenge=…`; Stridash echoes the
   challenge only when the token matches.

`POST /api/strava/webhook` accepts `activity` create/update events, finds the
active STRAVA connection by `owner_id`, atomically claims it and queues the
normal sync worker. Deletes are acknowledged but not applied (deletion
detection is still roadmap work). Each owner is capped at 30 events/minute.
Strava does not sign webhook POSTs, so the endpoint only trusts the
`owner_id` → active-connection lookup; the actual data still comes from the
authenticated Strava API.

## Sync behaviour

- **Watermark:** the first run asks Strava for activities after
  `STRIDASH_STRAVA_BACKFILL_DAYS`; later runs use `lastSyncedAt − 1 day` so a
  late upload is not missed. Pagination is 100 activities/page (max 50 pages
  per run).
- **Discovery → detail → streams:** the list row supplies scalars; the detail
  endpoint adds calories, suffer score, description and `gear_id`; `/streams`
  supplies the per-sample arrays stored in `activity_data_points`.
- **Failure handling:** a failed detail/streams/gear request degrades that
  activity to summary-only and marks the `sync_logs` row `PARTIAL`. A failed
  list page stops pagination with `PARTIAL`; credential/refresh failures mark
  the run `ERROR` (and the connection `ERROR` via the sync worker).
- **Dedup:** ingest goes through the shared `activity-ingest` service
  (provider identity first, then tolerance matching), and series through
  `activity-series`. A Strava ride that duplicates a Garmin/Zwift ride fills
  the empty gear/series slots instead of creating a second activity.
- **Gear:** `/gear/{id}` is fetched once per sync and upserted as
  `provider = STRAVA`; activity attribution fills an empty `gear_id` only.
- **Token refresh:** the access token is refreshed when it is within 60 s of
  expiry; the rotated pair and new expiry are persisted before syncing.

## Limits / not implemented yet

- Strava rate limits (100 requests/15 min, 1000/day) are respected by keeping
  pages bounded and caching gear, but there is no retry/backoff scheduler yet.
- Strava webhooks/polling are not wired; sync runs manually or through the
  interval scheduler.
- Force re-sync of a single activity (`POST /api/activities/:id/resync`) still
  answers 501 for STRAVA; the connection-level sync is the supported path.
- A live-account smoke test requires a real Strava API application (like the
  Garmin/iGPSPORT/Omron live checks).
