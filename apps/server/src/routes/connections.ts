import { Hono } from "hono";
import { z } from "zod";
import { prisma } from "../db.js";
import { requireUserId } from "../auth.js";
import { encryptToken } from "../crypto.js";
import { OmronConnectError, OmronConnectV1 } from "../providers/omron/client.js";
import { regionForCountry } from "../providers/omron/regions.js";
import { IgpSportClient, IgpSportError, peekJwtClaims } from "../providers/igpsport/client.js";
import { regionForKey } from "../providers/igpsport/regions.js";
import {
  garminSsoLogin,
  completeMfa,
  exchangeServiceTicket,
  GarminError,
  peekJwtExpMs,
  type MfaContext,
  type ServiceTicket,
} from "../providers/garmin/sso.js";
import { verifyToken, getProfile } from "../providers/garmin/api.js";
import { syncGarminConnection } from "../services/garmin-sync.js";
import { syncGarminWellness } from "../services/garmin-wellness.js";
import { decryptToken } from "../crypto.js";
import { syncIgpSportConnection } from "../services/igpsport-sync.js";
import { syncOmronConnection } from "../services/omron-sync.js";
import type { Env } from "../env.js";

const omronConnectSchema = z.object({
  provider: z.literal("OMRON"),
  /** Omron Connect account identifier — email OR username (the API's login
   * field is literally `username`; accounts register either way). */
  identifier: z.string().min(1),
  /** Verified against Omron immediately, never stored. */
  password: z.string().min(1),
  /** ISO 3166-1 alpha-2 country of the Omron Connect account. */
  country: z.string().length(2),
});

const igpsportConnectSchema = z.object({
  provider: z.literal("IGPSPORT"),
  /** iGPSPORT account username (the web client login). */
  username: z.string().min(1),
  /** Account password — verified against iGPSPORT, then kept AES-256-GCM
   * encrypted server-side because the API has no refresh-token grant. */
  password: z.string().min(1),
  /** Deployment: "intl" (default) or "cn" (unsupported — rejected). */
  region: z.enum(["intl", "cn"]).default("intl"),
});

const garminConnectSchema = z.object({
  provider: z.literal("GARMIN"),
  /** Garmin account email (the SSO `username` field). */
  email: z.string().min(1),
  /** Garmin account password — used once for the SSO login; only the session
   * tokens (DI access + refresh) are stored, both AES-256-GCM encrypted. */
  password: z.string().min(1),
});

const garminMfaSchema = z.object({
  /** Verification code from the second-factor channel (email/SMS/TOTP). */
  code: z.string().min(1).max(12),
});

export function connectionRoutes(env: Env): Hono<{ Variables: { userId: string } }> {
  const routes = new Hono<{ Variables: { userId: string } }>();

  routes.use("*", async (c, next) => {
    c.set("userId", await requireUserId(c, env.STRIDASH_JWT_SECRET));
    await next();
  });

  // ── List ───────────────────────────────────────────────────────────────────

  routes.get("/", async (c) => {
    const connections = await prisma.connection.findMany({
      where: { userId: c.get("userId") },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        provider: true,
        providerUserId: true,
        status: true,
        scopes: true,
        config: true,
        lastSyncedAt: true,
        createdAt: true,
        updatedAt: true,
        // tokens deliberately excluded — never leave the server
      },
    });

    return c.json({ items: connections, nextCursor: null });
  });

  // ── Connect: OMRON / IGPSPORT ─────────────────────────────────────────────

  routes.post("/", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (body?.provider === "IGPSPORT") return connectIgpSport(c, env, igpsportConnectSchema.safeParse(body));
    if (body?.provider === "GARMIN") return connectGarmin(c, env, garminConnectSchema.safeParse(body));
    const parsed = omronConnectSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid body", detail: parsed.error.flatten().fieldErrors }, 400);
    }
    const { identifier, password, country } = parsed.data;

    const region = regionForCountry(country);
    if (!region) {
      return c.json(
        {
          error: "Unsupported Omron region",
          detail: `No OmronConnect API v1 server serves country ${country.toUpperCase()}. Regions with full-fidelity scale data: ${["AU","BD","ID","MM","MY","NZ","PH","SG","TH","VN","HK","JP","KR","TW","IN","AR","BO","BR","CL","CO","CR","DO","EC","GT","HN","MX","NI","PA","PE","PY","SV","UY","VE"].join(", ")}`,
        },
        400,
      );
    }

    const client = new OmronConnectV1(region);
    let tokens;
    try {
      tokens = await client.login(identifier, password);
    } catch (err) {
      if (err instanceof OmronConnectError) {
        return c.json({ error: "Omron login failed", detail: err.message }, 401);
      }
      throw err;
    }

    // Provider-side identity: stable per-account; fall back to the identifier.
    let providerUserId = identifier;
    try {
      const me = await client.withAccessToken(tokens.accessToken).getUser();
      providerUserId = String(me.userID ?? me.loginName ?? me.email ?? identifier);
    } catch {
      // identity endpoint is best-effort; don't block connecting
    }

    const connection = await prisma.connection.upsert({
      where: {
        userId_provider_providerUserId: {
          userId: c.get("userId"),
          provider: "OMRON",
          providerUserId,
        },
      },
      create: {
        userId: c.get("userId"),
        provider: "OMRON",
        providerUserId,
        status: "ACTIVE",
        accessTokenEnc: encryptToken(tokens.accessToken, env.STRIDASH_ENC_KEY),
        refreshTokenEnc: encryptToken(tokens.refreshToken, env.STRIDASH_ENC_KEY),
        scopes: ["WEIGHT", "BPM"],
        config: { omron: { country: country.toUpperCase() } } as never,
      },
      update: {
        status: "ACTIVE",
        accessTokenEnc: encryptToken(tokens.accessToken, env.STRIDASH_ENC_KEY),
        refreshTokenEnc: encryptToken(tokens.refreshToken, env.STRIDASH_ENC_KEY),
        config: { omron: { country: country.toUpperCase() } } as never,
      },
      select: {
        id: true,
        provider: true,
        providerUserId: true,
        status: true,
        scopes: true,
        config: true,
        lastSyncedAt: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    return c.json(connection, 201);
  });

  /** iGPSPORT connect: log in once to verify credentials, persist tokens + identity. */
  async function connectIgpSport(
    c: any,
    env: Env,
    parsed: ReturnType<typeof igpsportConnectSchema.safeParse>,
  ) {
    if (!parsed.success) {
      return c.json({ error: "Invalid body", detail: parsed.error.flatten().fieldErrors }, 400);
    }
    const { username, password, region } = parsed.data;
    const regionProfile = regionForKey(region);
    if (!regionProfile || regionProfile.signing) {
      return c.json(
        {
          error: "Unsupported iGPSPORT region",
          detail: "Only international (app.igpsport.com) accounts are supported; CN accounts require the web client's WASM request signer.",
        },
        400,
      );
    }

    const client = new IgpSportClient(regionProfile);
    try {
      await client.login(username, password);
    } catch (err) {
      if (err instanceof IgpSportError) {
        return c.json({ error: "iGPSPORT login failed", detail: err.message }, 401);
      }
      throw err;
    }
    const token = client.currentToken();
    const claims = peekJwtClaims(token);
    const providerUserId = claims.memberId || username;
    const expiresAt = claims.exp
      ? new Date(claims.exp * 1000)
      : new Date(Date.now() + 3600 * 1000);

    const connection = await prisma.connection.upsert({
      where: {
        userId_provider_providerUserId: {
          userId: c.get("userId"),
          provider: "IGPSPORT",
          providerUserId,
        },
      },
      create: {
        userId: c.get("userId"),
        provider: "IGPSPORT",
        providerUserId,
        status: "ACTIVE",
        accessTokenEnc: encryptToken(token, env.STRIDASH_ENC_KEY),
        // NOTE: the iGPSPORT API has no usable refresh-token grant; the
        // account password (AES-256-GCM encrypted) re-authenticates on expiry.
        refreshTokenEnc: encryptToken(password, env.STRIDASH_ENC_KEY),
        tokenExpiresAt: expiresAt,
        scopes: ["activities"],
        config: { igpsport: { region, username } } as never,
      },
      update: {
        status: "ACTIVE",
        accessTokenEnc: encryptToken(token, env.STRIDASH_ENC_KEY),
        refreshTokenEnc: encryptToken(password, env.STRIDASH_ENC_KEY),
        tokenExpiresAt: expiresAt,
        config: { igpsport: { region, username } } as never,
      },
      select: {
        id: true,
        provider: true,
        providerUserId: true,
        status: true,
        scopes: true,
        config: true,
        lastSyncedAt: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    return c.json(connection, 201);
  }

  /**
   * Garmin connect: run the SSO strategy chain once to verify the credentials
   * and capture a DI token pair.
   *
   * 202 (PENDING_MFA): second factor required — repeat with
   * `POST /connections/:id/mfa {code}` (state persists on the connection;
   * the password is not stored and not needed again for MFA retries).
   */
  async function connectGarmin(c: any, env: Env, parsed: ReturnType<typeof garminConnectSchema.safeParse>) {
    if (!parsed.success) {
      return c.json({ error: "Invalid body", detail: parsed.error.flatten().fieldErrors }, 400);
    }
    const { email, password } = parsed.data;

    let outcome: ServiceTicket | MfaContext;
    try {
      // Deliberately slow: 2–20 s of anti-WAF delay per strategy is part of
      // the protocol (Cloudflare deflects tight GET→POST sequences).
      outcome = await garminSsoLogin(email, password);
    } catch (err) {
      if (err instanceof GarminError) {
        const status = err.kind === "CREDENTIALS" ? 401 : err.kind === "RATE_LIMITED" ? 429 : 502;
        return c.json({ error: "Garmin login failed", detail: err.message, kind: err.kind }, status);
      }
      throw err;
    }

    if ("flow" in outcome) {
      // MFA_REQUIRED — park the pending login (SSO session cookies, also
      // secret) encrypted; the caller completes it with the code.
      const connection = await prisma.connection.upsert({
        where: {
          userId_provider_providerUserId: {
            userId: c.get("userId"),
            provider: "GARMIN",
            providerUserId: email, // placeholder identity until the login completes
          },
        },
        create: {
          userId: c.get("userId"),
          provider: "GARMIN",
          providerUserId: email,
          status: "PENDING",
          refreshTokenEnc: encryptToken(JSON.stringify(outcome), env.STRIDASH_ENC_KEY),
          config: { garmin: { email, pendingMfaMethod: outcome.method } } as never,
        },
        update: {
          status: "PENDING",
          refreshTokenEnc: encryptToken(JSON.stringify(outcome), env.STRIDASH_ENC_KEY),
          accessTokenEnc: null,
          tokenExpiresAt: null,
          config: { garmin: { email, pendingMfaMethod: outcome.method } } as never,
        },
        select: { id: true, provider: true, providerUserId: true, status: true, config: true, createdAt: true, updatedAt: true },
      });
      return c.json(
        { mfaRequired: true, method: outcome.method, message: "Resend the code with POST /connections/:id/mfa {code}", connection },
        202,
      );
    }

    // SUCCESSFUL — exchange the CAS ticket for the native DI token pair.
    let di;
    try {
      di = await exchangeServiceTicket(outcome.ticket, outcome.serviceUrl);
    } catch (err) {
      if (err instanceof GarminError) {
        return c.json({ error: "Garmin token exchange failed", detail: err.message }, 502);
      }
      throw err;
    }

    // The API tier rejects some region/login combos with 401 — surface it
    // instead of storing a token that cannot sync (garth's _verify_token).
    if (!(await verifyToken(di.diToken))) {
      return c.json(
        {
          error: "Garmin token rejected by API tier",
          detail: "The SSO login succeeded but connectapi.garmin.com refused the session (401/403). Try connecting again later — the strategy chain may pick a different flow.",
        },
        502,
      );
    }

    let providerUserId = email;
    try {
      const me = await getProfile(di.diToken);
      providerUserId = String(me.displayName ?? me.userName ?? me.userId ?? email);
    } catch {
      // identity endpoint is best-effort; don't block connecting
    }

    const connection = await prisma.connection.upsert({
      where: {
        userId_provider_providerUserId: {
          userId: c.get("userId"),
          provider: "GARMIN",
          providerUserId,
        },
      },
      create: {
        userId: c.get("userId"),
        provider: "GARMIN",
        providerUserId,
        status: "ACTIVE",
        accessTokenEnc: encryptToken(di.diToken, env.STRIDASH_ENC_KEY),
        refreshTokenEnc: di.diRefreshToken ? encryptToken(di.diRefreshToken, env.STRIDASH_ENC_KEY) : null,
        tokenExpiresAt: peekJwtExpMs(di.diToken) ? new Date(peekJwtExpMs(di.diToken)!) : null,
        scopes: ["activities"],
        config: { garmin: { email, diClientId: di.diClientId } } as never,
      },
      update: {
        status: "ACTIVE",
        accessTokenEnc: encryptToken(di.diToken, env.STRIDASH_ENC_KEY),
        refreshTokenEnc: di.diRefreshToken ? encryptToken(di.diRefreshToken, env.STRIDASH_ENC_KEY) : null,
        tokenExpiresAt: peekJwtExpMs(di.diToken) ? new Date(peekJwtExpMs(di.diToken)!) : null,
        config: { garmin: { email, diClientId: di.diClientId } } as never,
      },
      select: {
        id: true, provider: true, providerUserId: true, status: true, scopes: true, config: true, lastSyncedAt: true, createdAt: true, updatedAt: true,
      },
    });
    return c.json(connection, 201);
  }

  /** Complete a pending Garmin MFA login with the verification code. */
  routes.post("/:id/mfa", async (c) => {
    const id = c.req.param("id");
    const parsed = garminMfaSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: "Invalid body", detail: parsed.error.flatten().fieldErrors }, 400);
    }
    const connection = await prisma.connection.findFirst({
      where: { id, userId: c.get("userId"), provider: "GARMIN" },
    });
    if (!connection) return c.json({ error: "Not found" }, 404);
    if (connection.status !== "PENDING" || !connection.refreshTokenEnc) {
      return c.json({ error: "Connection is not awaiting MFA" }, 409);
    }

    let ctx: MfaContext;
    try {
      ctx = JSON.parse(decryptToken(connection.refreshTokenEnc, env.STRIDASH_ENC_KEY)) as MfaContext;
    } catch {
      return c.json({ error: "Stored MFA state is invalid — reconnect the account" }, 409);
    }

    let ticket: ServiceTicket;
    try {
      ticket = await completeMfa(ctx, parsed.data.code);
    } catch (err) {
      if (err instanceof GarminError) {
        // RATE_LIMITED / retryable validation errors keep the pending state
        // (matching garth: a wrong code does not destroy the session).
        const status = err.kind === "RATE_LIMITED" ? 429 : 401;
        return c.json({ error: "Garmin MFA failed", detail: err.message }, status);
      }
      throw err;
    }

    let di;
    try {
      di = await exchangeServiceTicket(ticket.ticket, ticket.serviceUrl);
    } catch (err) {
      if (err instanceof GarminError) {
        return c.json({ error: "Garmin token exchange failed", detail: err.message }, 502);
      }
      throw err;
    }
    if (!(await verifyToken(di.diToken))) {
      return c.json({ error: "Garmin token rejected by API tier after MFA" }, 502);
    }

    let providerUserId = (connection.config as { garmin?: { email?: string } })?.garmin?.email ?? connection.providerUserId;
    try {
      const me = await getProfile(di.diToken);
      providerUserId = String(me.displayName ?? me.userName ?? me.userId ?? providerUserId);
    } catch {
      // best-effort identity
    }

    const exp = peekJwtExpMs(di.diToken);
    const updated = await prisma.connection.update({
      where: { id: connection.id },
      data: {
        status: "ACTIVE",
        providerUserId,
        accessTokenEnc: encryptToken(di.diToken, env.STRIDASH_ENC_KEY),
        refreshTokenEnc: di.diRefreshToken ? encryptToken(di.diRefreshToken, env.STRIDASH_ENC_KEY) : null,
        tokenExpiresAt: exp ? new Date(exp) : null,
        config: {
          garmin: {
            email: providerUserId,
            diClientId: di.diClientId,
          },
        } as never,
      },
      select: {
        id: true, provider: true, providerUserId: true, status: true, scopes: true, config: true, lastSyncedAt: true, createdAt: true, updatedAt: true,
      },
    });
    return c.json(updated, 200);
  });

  // ── Revoke ─────────────────────────────────────────────────────────────────

  routes.delete("/:id", async (c) => {
    const id = c.req.param("id");
    const connection = await prisma.connection.findFirst({
      where: { id, userId: c.get("userId") },
    });
    if (!connection) return c.json({ error: "Not found" }, 404);

    await prisma.connection.update({
      where: { id },
      data: { status: "REVOKED", accessTokenEnc: null, refreshTokenEnc: null, tokenExpiresAt: null },
    });
    return c.json({ ok: true });
  });

  // ── Sync now ───────────────────────────────────────────────────────────────

  routes.post("/:id/sync", async (c) => {
    const id = c.req.param("id");
    const connection = await prisma.connection.findFirst({
      where: { id, userId: c.get("userId") },
    });
    if (!connection) return c.json({ error: "Not found" }, 404);
    if (connection.provider !== "OMRON" && connection.provider !== "IGPSPORT" && connection.provider !== "GARMIN") {
      return c.json({ error: "Provider does not support sync yet" }, 501);
    }

    if (connection.provider === "IGPSPORT") {
      const result = await syncIgpSportConnection(env, connection);
      return c.json({ result });
    }
    if (connection.provider === "GARMIN") {
      const result = await syncGarminConnection(env, connection);
      // sleep/daily-metrics pass runs below the activities so one tap syncs
      // both; a wellness failure doesn't invalidate the activities result
      let wellness: Awaited<ReturnType<typeof syncGarminWellness>> | undefined;
      try {
        wellness = await syncGarminWellness(env, connection);
      } catch (err) {
        console.error("[garmin] wellness sync failed:", err);
      }
      return c.json({ result, wellness });
    }
    const result = await syncOmronConnection(env, connection);
    return c.json({ result });
  });

  // ── Sync history ───────────────────────────────────────────────────────────

  routes.get("/:id/syncs", async (c) => {
    const id = c.req.param("id");
    const connection = await prisma.connection.findFirst({
      where: { id, userId: c.get("userId") },
      select: { id: true },
    });
    if (!connection) return c.json({ error: "Not found" }, 404);

    const logs = await prisma.syncLog.findMany({
      where: { connectionId: id },
      orderBy: { startedAt: "desc" },
      take: 50,
    });
    return c.json({ items: logs, nextCursor: null });
  });

  return routes;
}
