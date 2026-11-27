# API tokens

Long-lived per-user tokens for MCP servers and automation. Browser sessions use
the short-lived JWT + rotating refresh token; API tokens are separate and are
not accepted by `/api/auth/refresh`.

## Create

```http
POST /api/tokens
Authorization: Bearer <browser JWT>
Content-Type: application/json

{ "name": "MCP home server", "expiresInDays": 90 }
```

`expiresInDays` is optional (max 3650); omit it for a non-expiring token. The
response includes the raw `sdat_…` token **once**; only its SHA-256 hash is
stored. The `prefix` field is safe to show in a token list.

## Use

Send it exactly like a JWT:

```http
Authorization: Bearer sdat_…
```

It works on every route that accepts the app session (`/api/me`, activities,
measurements, connections, sync triggers, exports, etc.). `lastUsedAt` is
updated at most every five minutes.

## List / revoke

```http
GET /api/tokens
DELETE /api/tokens/{id}
```

Listing never returns the hash or raw value. Revoking deletes the row
immediately; existing requests already past authentication may finish, but the
next request gets `401`.

## Security notes

- Treat a token like a password; store it in the client's secret store.
- Tokens are scoped to one user and inherit that user's authorization checks.
- Account deletion cascades all tokens.
- Rotate by creating a new token, switching the client, then revoking the old
  one.
