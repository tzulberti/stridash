/**
 * Redact token-shaped values inside a provider error detail before it is
 * written to the sync log or returned to the client. Providers occasionally
 * echo the credentials they just rejected (Omron's token-refresh error body
 * includes the access token), and those values must never be echoed further —
 * a list-specific string like "eyJ…" identifies the token without exposing it.
 */
export function redactProviderDetail(detail: unknown, depth = 0): unknown {
  if (depth > 6 || detail === null || detail === undefined) return detail;
  if (Array.isArray(detail)) return detail.map((v) => redactProviderDetail(v, depth + 1));
  if (typeof detail === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(detail as Record<string, unknown>)) {
      out[k] = TOKEN_KEYS.has(k.toLowerCase()) ? redactToken(v) : redactProviderDetail(v, depth + 1);
    }
    return out;
  }
  return detail;
}

/** keys whose string values are credentials, not diagnostics */
const TOKEN_KEYS = new Set([
  "accesstoken", "refreshtoken", "idtoken", "token", "sessionkey", "password", "credential",
]);

/** keep enough of the value to identify which token failed ("eyJ…7f2a"), drop the rest */
function redactToken(value: unknown): unknown {
  if (typeof value !== "string" || !value) return value;
  return value.length > 24 ? `${value.slice(0, 12)}…${value.slice(-4)}` : "…";
}
