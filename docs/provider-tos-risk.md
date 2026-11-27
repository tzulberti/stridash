# Provider terms-of-service risk

Stridash is a self-hosted, read-only aggregator for an operator's **own**
accounts. This note records the known terms-of-service position for each
provider integration. It is an engineering risk note, not legal advice.

## Summary

| Provider | Integration method | Terms position | Practical exposure | Mitigation |
| --- | --- | --- | --- | --- |
| **Strava** | Official OAuth API v3 | Official API; developer terms/rate limits apply | Rate limiting or app suspension for API misuse | OAuth only, documented scopes, bounded paging, no scraping, no redistribution |
| **Garmin Connect** | Unofficial SSO-scraping / DI API | Not an official integration; account terms prohibit automated access | Account flagging or login blocks, mainly Cloudflare/anti-bot | Own-account read-only use, conservative delays, no credential sharing, migrate to Garmin Personal API |
| **iGPSPORT** | Unofficial private web API | ToU §5.2 prohibits reverse engineering / unauthorised API use | Account flagging; possible access removal | Own-account read-only use, stop-at-known-page paging, apply for official OpenAPI access |
| **Zwift** | Unofficial game-client API | §5.a prohibits unofficial clients / interacting without written authorisation | Shadow-ban, ride data disregard, or account termination at Zwift’s discretion | Own-account read-only use, no writes/social actions, no redistribution; accept or disconnect |
| **Omron Connect** | Unofficial mobile-app protocol | Unofficial; no public OAuth programme for the supported v1 regions | Account/data access disruption | Own-account read-only use, encrypted credentials, migrate to Omron Connect Partner API |
| **Manual entries** | Stridash-local | No provider involved | None | — |

## Provider notes

### Strava — official API

- Uses OAuth2 with `read,activity:read_all,profile:read_all`, documented
  `/api/v3` endpoints, and the documented token refresh flow.
- Stridash does not scrape the Strava website, does not write activities, and
  does not republish Strava data.
- Strava's API agreement and rate limits still apply; the scheduler is bounded
  and should be disabled or lengthened if the app is rate-limited.
- Keep the API application's callback domain and client secret private.

### Garmin Connect — unofficial

- Garmin's consumer terms prohibit automated access and credential sharing.
  The SSO chain deliberately behaves like the mobile/web clients, including
  anti-WAF delays, but that does not make it authorised.
- The exposure is usually anti-bot friction (locked/flagged account), not a
  legal claim, for a single self-hosted personal account.
- **Planned migration:** Garmin Personal API (per-user API key, 24-hour bearer)
  removes the scraping path. Track it in the roadmap (M3).

### iGPSPORT — unofficial

- The web client's private API is reverse-engineered. iGPSPORT's terms prohibit
  reverse engineering and unauthorised API use (roadmap M2.1).
- CN-region support would require executing the web client's WASM signer; it is
  deliberately not shipped.
- **Exit path:** official OpenAPI access (application via iGPSPORT support) and
  a documented OAuth2 client.

### Zwift — unofficial, highest policy risk

- Zwift §5.a explicitly prohibits unofficial clients, reverse engineering,
  scraping, and applications that interact with the platform without prior
  written authorisation. Zwift reserves shadow-ban, ride-data disregard, and
  termination at its sole discretion.
- There is no official public API. Stridash only reads activities/series for an
  account the operator owns; it never writes, races, drafts, messages, or uses
  the social graph.
- Operators who cannot accept this risk should not connect Zwift; there is no
  official alternative today.

### Omron Connect — unofficial

- The v1 protocol mirrors the Omron Connect mobile app. Omron offers an
  official **Omron Connect Partner API** (OAuth2 + consent) for approved
  partners; the app registration/approval is still pending (roadmap M4).
- Until then, credentials are encrypted at rest and used read-only.

## Operating rules

1. Connect only accounts you own and are authorised to access.
2. Never share provider credentials or tokens. Stridash stores tokens
   AES-256-GCM encrypted and never returns them from the API.
3. Keep the deployment private/self-hosted; do not resell access or redistribute
   provider data.
4. Respect rate limits and keep the scheduler at a conservative interval.
5. Disconnect/revoke a provider promptly if it asks, or if the account is
   flagged.
6. Re-evaluate this note before multi-user/commercial use or before adding a
   write-capable feature.

## Change triggers

- Official API access is obtained for Garmin, iGPSPORT or Omron.
- A provider sends a request or warning about the integration.
- The deployment starts serving users other than the operator.
- A feature would write data or access social/private data beyond the current
  read-only scope.
