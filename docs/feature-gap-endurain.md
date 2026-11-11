# Feature gap vs Endurain

Snapshot from 2026-11-11, taken from Endurain's README, docs
(docs.endurain.com) and ROADMAP.md. Endurain is the closest self-hosted
peer: same license (AGPL v3), same "own your data" stance, but a very
different connector set and data-fidelity philosophy. This doc lists what
Endurain ships that Stridash does not (yet) — organized by category, with
notes on what is worth adopting and what is not.

Endurain's project is on a **feature freeze since 2026-05** (foundations
focus, ROADMAP.md), so this snapshot is stable.

## Status

| Endurain feature | Stridash | Verdict |
|---|---|---|
| Gear tracking + per-activity gear (Garmin) | ✅ shipped | Garmin's gear-service v2 synced at ingest; per-activity links map to `activities.gear_id` |
| Gear component tracking (replace-by-usage) | ✅ shipped | Stridash-managed `gear_components`; usage computed from linked activities' distance |
| Manual `.gpx`/`.tcx`/`.fit` upload | ❌ missing | Worth adopting — no-provider fallback + recovery path when a provider API breaks |
| Account MFA (TOTP) | ❌ missing | Worth adopting — cheap win for an internet-exposed self-hosted service |
| Goals (define + track) | ❌ missing | Fits the dashboard naturally |
| Gear components | ✅ shipped | see above |
| Followers / social feed | ❌ missing | Deliberate scope cut for now |
| Activity privacy settings | ❌ missing | Only matters once there is sharing |
| Multi-user admin surface | ❌ missing | Single-user first |
| Sleep **scoring** algorithm | ❌ missing | We store provider scores (`sleep_score`); a home-grown scorer is low priority |
| Notifications | ❌ missing | No strong driver yet |
| Third-party API keys / OAuth-PKCE / WebSocket | ❌ missing | Session-token API only |
| SSO login (OIDC/SAML) | ❌ missing | Nice for self-hosters with Authentik/Authelia; later |
| SMTP email (password reset, signup approval) | ❌ missing | Later |
| i18n (12 languages) | ❌ missing | Later |
| Imperial/metric units | ❌ missing (metric only) | Cheap to add when asked |
| Dark/light theme | partial | Follows system only |
| Full data export/import | ❌ missing | Worth adopting for the self-hosted ethos |
| Public demo instance | ❌ missing | Later |

## Where Stridash is ahead

- **Connectors**: Zwift (private game-client protocol with workout names,
  HR/power enrichment and full `detail_raw` payloads), iGPSPORT, and
  Omron HBF-702T body composition (17 values per weigh-in) + Garmin
  daily wellness/sleep. Endurain syncs Strava + Garmin activities/gear
  and body composition only.
- **Fidelity**: per-sample activity series (17 channels), provider
  detail payloads stored as-received (`detail_raw`), and self-healing
  upgrade passes that enrich legacy rows on later syncs.
- **Engineering**: hand-written numbered migrations with CI regression
  coverage, three-tier test suite (unit / integration-on-testcontainers
  / web), prettier + eslint + typecheck gates on every PR.

## Deliberate non-goals (for now)

Endurain's roadmap doubles down on social: text posts, threaded
comments, reactions, events, challenges with leaderboards and badges,
and even ActivityPub federation. That is a product-direction choice we
are not following for a single-user instance — revisit if Stridash ever
becomes multi-user.

## Sources

- https://github.com/endurain-project/endurain (README)
- https://docs.endurain.com (Features)
- https://github.com/endurain-project/endurain/blob/master/ROADMAP.md
