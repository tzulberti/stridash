/**
 * Shared Garmin DI-token plumbing: rehydrate the encrypted token columns and
 * refresh via the DI grant when the JWT is (nearly) expired.
 */

import { prisma } from "../db.js";
import { encryptToken, decryptToken } from "../crypto.js";
import { GarminError, type DiTokens } from "../providers/garmin/sso.js";
import { maybeRefresh } from "../providers/garmin/api.js";
import type { Env } from "../env.js";

export interface GarminConnectionLike {
  id: string;
  userId: string;
  tokenExpiresAt?: unknown;
  lastSyncedAt?: unknown;
  accessTokenEnc: string | null;
  refreshTokenEnc: string | null;
  status: string;
  config: unknown;
}

/** Rehydrate DI tokens from the encrypted columns; refresh if close to expiry. */
export async function ensureGarminTokens(
  env: Env,
  connection: GarminConnectionLike,
): Promise<string> {
  if (connection.status === "REVOKED") {
    throw new GarminError("CONNECTION", "Connection revoked — reconnect the Garmin account first");
  }
  if (!connection.accessTokenEnc) {
    throw new GarminError("CONNECTION", "No Garmin credentials stored — reconnect the account");
  }
  const diToken = decryptToken(connection.accessTokenEnc, env.STRIDASH_ENC_KEY);
  const diRefreshToken = connection.refreshTokenEnc
    ? decryptToken(connection.refreshTokenEnc, env.STRIDASH_ENC_KEY)
    : undefined;
  const cfg = connection.config as { garmin?: { diClientId?: string } } | null;
  const diClientId = cfg?.garmin?.diClientId ?? "GARMIN_CONNECT_MOBILE_ANDROID_DI";

  const tokens: DiTokens = { diToken, diRefreshToken: diRefreshToken ?? undefined, diClientId };
  const { fresh, tokens: next } = await maybeRefresh(tokens);
  if (!fresh) {
    await prisma.connection.update({
      where: { id: connection.id },
      data: {
        accessTokenEnc: encryptToken(next.diToken, env.STRIDASH_ENC_KEY),
        refreshTokenEnc: next.diRefreshToken ? encryptToken(next.diRefreshToken, env.STRIDASH_ENC_KEY) : null,
        tokenExpiresAt: null, // refreshed below right after — claims re-checked cheaply
        status: "ACTIVE",
      },
    });
    return next.diToken;
  }
  return diToken;
}
