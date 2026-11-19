/**
 * Redact token-shaped values before they reach a log, a sync row, or a client.
 * Providers occasionally echo the credentials they just rejected (Omron's
 * token-refresh error body includes the access token), and free-text errors
 * can carry the same values. Keep enough of each value to identify it
 * ("eyJ…7f2a") but drop the rest.
 */
export function redactProviderDetail(detail: unknown, depth = 0): unknown {
  if (depth > 6 || detail === null || detail === undefined) return detail;
  if (Array.isArray(detail)) return detail.map((v) => redactProviderDetail(v, depth + 1));
  if (typeof detail === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(detail as Record<string, unknown>)) {
      out[k] = TOKEN_KEYS.has(k.toLowerCase())
        ? typeof v === 'string'
          ? redactToken(v)
          : redactProviderDetail(v, depth + 1)
        : redactProviderDetail(v, depth + 1);
    }
    return out;
  }
  if (typeof detail === 'string') return redactText(detail);
  return detail;
}

/**
 * Scrub credential-shaped substrings out of free text. This is the last line
 * of defence for error messages that are not keyed by a known token name
 * (`Authorization: Bearer …`, JWTs pasted into a provider detail, …).
 */
export function redactText(text: string): string {
  return text
    .replace(BEARER_RE, '$1[redacted]')
    .replace(JWT_RE, (match) => redactToken(match) as string);
}

/** A structured, redacted view of an unknown error for console logging. */
export function safeErrorForLog(err: unknown): unknown {
  if (!(err instanceof Error)) return redactProviderDetail(err);

  const out: Record<string, unknown> = {
    name: err.name,
    message: redactText(err.message),
    stack: err.stack ? redactText(err.stack) : undefined,
  };
  // Provider errors carry useful, non-standard fields (status, detail, kind).
  for (const [key, value] of Object.entries(err)) {
    if (key in out) continue;
    out[key] = redactProviderDetail(value);
  }
  return out;
}

/** keys whose string values are credentials, not diagnostics */
const TOKEN_KEYS = new Set([
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'token',
  'sessionkey',
  'password',
  'credential',
]);

/** `Authorization: Bearer <token>` — token part is base64url-ish or opaque. */
const BEARER_RE = /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi;

/** JWT-shaped values: three dot-separated base64url segments, header starts eyJ. */
const JWT_RE = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;

/** keep enough of the value to identify which token failed ("eyJ…7f2a"), drop the rest */
function redactToken(value: unknown): unknown {
  if (typeof value !== 'string' || !value) return value;
  return value.length > 24 ? `${value.slice(0, 12)}…${value.slice(-4)}` : '…';
}
