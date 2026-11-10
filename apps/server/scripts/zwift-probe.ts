/** Live protocol probe: refresh the stored Zwift token pair, fetch one
 * activity's detail, print its SHAPE (keys only, no secrets). */
import { prisma } from "../src/db.js";
import { decryptToken } from "../src/crypto.js";
import { ZwiftClient, zwiftRefresh } from "../src/providers/zwift/client.js";
import { loadEnv } from "../src/env.js";

const [, , activityIdArg] = process.argv;

const env = loadEnv();
const conn = await prisma.connection.findFirst({
  where: { provider: "ZWIFT" },
  select: { id: true, providerUserId: true, accessTokenEnc: true, refreshTokenEnc: true, tokenExpiresAt: true },
});
if (!conn) {
  console.log("no ZWIFT connection");
  process.exit(1);
}

let access = decryptToken(conn.accessTokenEnc!, env.STRIDASH_ENC_KEY);
const expMs = conn.tokenExpiresAt ? new Date(conn.tokenExpiresAt).getTime() : 0;
if (!access || Date.now() > expMs - 60_000) {
  const refresh = decryptToken(conn.refreshTokenEnc!, env.STRIDASH_ENC_KEY);
  const tokens = await zwiftRefresh(refresh);
  await prisma.connection.update({
    where: { id: conn.id },
    data: {
      accessTokenEnc: tokens.accessToken,
      refreshTokenEnc: tokens.refreshToken,
      tokenExpiresAt: new Date(Date.now() + tokens.expiresIn * 1000),
    },
  });
  access = tokens.accessToken;
  console.log("(tokens rotated)");
}

const client = new ZwiftClient(conn.providerUserId).withAccessToken(access);
const detail = await client.getActivityDetail(activityIdArg!);
console.log("top-level keys:", Object.keys(detail).sort().join(", "));
console.log("fitnessData:", detail.fitnessData ? JSON.stringify(Object.keys(detail.fitnessData), null, 1) : null);
if (detail.fitnessData?.fullDataUrl) {
  console.log("fullDataUrl =", detail.fitnessData.fullDataUrl);
  const fit = await client.getFitnessData(detail.fitnessData.fullDataUrl);
  for (const [k, v] of Object.entries(fit)) {
    if (Array.isArray(v)) console.log("stream:", k, `len=${v.length}`, "head:", JSON.stringify(v.slice(0, 4)));
  }
}
// hunt for other field names carrying a url or sample arrays
for (const [k, v] of Object.entries(detail)) {
  if (typeof v === "string" && /https?:|\/(fit|api|graph)/.test(v)) console.log("URL-ish field:", k, "=", v.slice(0, 120));
  if (Array.isArray(v)) console.log("array field:", k, `len=${v.length}`, "sample:", JSON.stringify(v.slice(0, 5)));
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const keys = Object.keys(v as Record<string, unknown>);
    const arrays = keys.filter((k2) => Array.isArray((v as Record<string, unknown>)[k2]));
    if (arrays.length) console.log("object with arrays:", k, "→", arrays.join(", "));
  }
}
await prisma.$disconnect();
