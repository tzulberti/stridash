# Deployment & secret hygiene

Stridash handles provider account credentials (Garmin/Zwift/Omron tokens and
the iGPSPORT password, which that API requires reversibly). Treat the server
and its database as sensitive infrastructure.

## TLS is mandatory

The API must never be exposed over plain HTTP. Run it behind a TLS-terminating
reverse proxy on the same host/private network, and only publish the proxy's
443 port:

```
Internet ──TLS──> Caddy/nginx ──HTTP──> 127.0.0.1:3000 (Stridash)
```

Caddy example:

```caddyfile
stridash.example.com {
  encode zstd gzip
  reverse_proxy 127.0.0.1:3000
  header {
    Strict-Transport-Security "max-age=31536000; includeSubDomains"
  }
}
```

nginx example:

```nginx
server {
  listen 443 ssl http2;
  server_name stridash.example.com;
  # ssl_certificate / ssl_certificate_key ...
  add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;

  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto https;
  }
}
```

- Set `STRIDASH_TRUST_PROXY=true` **only** when the proxy overwrites
  `X-Forwarded-For`; otherwise clients can spoof their IP and bypass the
  auth/connection rate limiters.
- The mobile app's `http://localhost:3000` default is for local development
  only. Point `EXPO_PUBLIC_API_URL` at the HTTPS host before testing from a
  phone.
- Add `X-Content-Type-Options`, `Referrer-Policy`, `X-Frame-Options` and a CSP
  at the static host/proxy when the web build is deployed (S10 still tracks the
  concrete CSP).

## Encryption keys

| Variable | Purpose |
|---|---|
| `STRIDASH_ENC_KEY` | Required. Legacy/app key; always decrypts `v1` rows. |
| `STRIDASH_PROVIDER_ENC_KEY` | Optional dedicated key for new provider-token writes. |
| `STRIDASH_ENC_KEY_ID` | Id recorded in `v2` ciphertext (default `app-v1`). |
| `STRIDASH_PROVIDER_ENC_KEY_ID` | Provider key id (default `provider-v1`). |
| `STRIDASH_ENC_SALT` | KDF salt for new `v2` writes; embedded in the ciphertext. A random per-process salt is used if unset. |
| `STRIDASH_ENC_OLD_KEYS` | JSON `{ "<id>": "<key>" }`; decrypt-only retirement keys. |

Generate key material with `openssl rand -hex 32`; generate the salt with
`openssl rand -base64 16`. Keep these out of git and back them up separately
from the database — losing them makes the encrypted provider credentials
unrecoverable.

Ciphertext is versioned:

- `v1:<iv>:<tag>:<ciphertext>` — legacy rows; fixed KDF salt, app key only.
- `v2:<keyId>:<salt>:<iv>:<tag>:<ciphertext>` — the key id and KDF salt are
  embedded, so a deployment can rotate keys or salts and still read old rows.

New writes use `STRIDASH_PROVIDER_ENC_KEY` when set, otherwise
`STRIDASH_ENC_KEY`. Existing `v1` rows keep working without a migration.

## Rotating a key

1. Generate the new key and pick a new key id, e.g. `provider-2`.
2. Put the previous key in `STRIDASH_ENC_OLD_KEYS` and point
   `STRIDASH_PROVIDER_ENC_KEY` / `STRIDASH_PROVIDER_ENC_KEY_ID` at the new pair.
3. Restart the server (new writes now use the new key).
4. Re-encrypt existing rows:

   ```bash
   npm run crypto:reencrypt -w @stridash/server -- --dry-run
   npm run crypto:reencrypt -w @stridash/server
   ```

5. Verify the run reports `failed 0`, then remove the old entry from
   `STRIDASH_ENC_OLD_KEYS` and restart.

Take a database backup before step 4. The script rewrites `accessTokenEnc` and
`refreshTokenEnc`; rows that cannot be decrypted are reported and left
untouched, and the process exits non-zero.
