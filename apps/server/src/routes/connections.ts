import { Hono } from "hono";
import { z } from "zod";
import { prisma } from "../db.js";
import { requireUserId } from "../auth.js";
import { encryptToken } from "../crypto.js";
import { OmronConnectError, OmronConnectV1 } from "../providers/omron/client.js";
import { regionForCountry } from "../providers/omron/regions.js";
import { IgpSportClient, IgpSportError, peekJwtClaims } from "../providers/igpsport/client.js";
import { regionForKey } from "../providers/igpsport/regions.js";
import { syncIgpSportConnection } from "../services/igpsport-sync.js";
import { syncOmronConnection } from "../services/omron-sync.js";
import type { Env } from "../env.js";

const omronConnectSchema = z.object({
  provider: z.literal("OMRON"),
  /** Omron Connect account email + password. Verified immediately, never stored. */
  email: z.string().email(),
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
    const parsed = omronConnectSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid body", detail: parsed.error.flatten().fieldErrors }, 400);
    }
    const { email, password, country } = parsed.data;

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
      tokens = await client.login(email, password);
    } catch (err) {
      if (err instanceof OmronConnectError) {
        return c.json({ error: "Omron login failed", detail: err.message }, 401);
      }
      throw err;
    }

    // Provider-side identity: stable per-account; fall back to the email.
    let providerUserId = email;
    try {
      const me = await client.withAccessToken(tokens.accessToken).getUser();
      providerUserId = String(me.userID ?? me.loginName ?? me.email ?? email);
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
    if (connection.provider !== "OMRON" && connection.provider !== "IGPSPORT") {
      return c.json({ error: "Provider does not support sync yet" }, 501);
    }

    if (connection.provider === "IGPSPORT") {
      const result = await syncIgpSportConnection(env, connection);
      return c.json({ result });
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
