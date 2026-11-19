/**
 * Minimal cookie jar for the Garmin SSO flows.
 *
 * Node's fetch does no cookie handling, and the SSO login depends on session
 * cookies set while walking the sign-in pages (SESSION, __cf_bm, JWT_WEB, …).
 * Garmin only ever needs *garmin.com* suffix matching plus host-only cookies,
 * so a simple name/domain bag is enough — no full RFC 6265 parser.
 *
 * The jar is deliberately restricted to garmin.com: a provider (or a
 * compromised redirect) must not be able to plant a `Domain=.com` cookie that
 * would then be sent to every host, nor can a non-Garmin origin seed cookies.
 */

export interface StoredCookie {
  name: string;
  value: string;
  /** Empty string ⇒ host-only cookie for `origin`'s host. */
  domain: string;
  /** Origin host the cookie was received from (used when domain is empty). */
  host: string;
}

const GARMIN_DOMAIN = 'garmin.com';

export function isGarminHost(host: string): boolean {
  const h = host.toLowerCase();
  return h === GARMIN_DOMAIN || h.endsWith(`.${GARMIN_DOMAIN}`);
}

/** A Domain attribute is acceptable only if it is garmin.com and domain-matches the origin. */
function isAllowedDomain(domain: string, originHost: string): boolean {
  const d = domain.toLowerCase();
  const h = originHost.toLowerCase();
  return isGarminHost(d) && (h === d || h.endsWith(`.${d}`));
}

export class CookieJar {
  private cookies = new Map<string, StoredCookie>();

  /** Merge every Set-Cookie of a response under the URL's host. */
  capture(url: URL, response: Response): void {
    const host = url.hostname.toLowerCase();
    if (!isGarminHost(host)) return;

    const headers =
      typeof (response.headers as { getSetCookie?: () => string[] }).getSetCookie === 'function'
        ? (response.headers as { getSetCookie: () => string[] }).getSetCookie()
        : [];
    for (const raw of headers) {
      // Truncate at the first ";" — we only need name, value, Domain.
      const sep = raw.indexOf(';');
      const line = sep === -1 ? raw : raw.slice(0, sep);
      const eq = line.indexOf('=');
      if (eq <= 0) continue;
      const name = line.slice(0, eq).trim();
      const value = line.slice(eq + 1).trim();
      const domainMatch = /(?:^|;\s*)domain=([^;]+)/i.exec(raw);
      const domain = domainMatch?.[1]?.replace(/^\./, '').toLowerCase() ?? '';
      if (domain && !isAllowedDomain(domain, host)) continue;
      // key: replacing a cookie never keyed on path (Garmin uses "/")
      this.cookies.set(`${name}@${domain || host}`, {
        name,
        value,
        domain,
        host,
      });
    }
  }

  /** Cookie header for the URL (browser-style suffix matching). */
  headerFor(url: URL): string | undefined {
    const host = url.hostname.toLowerCase();
    if (!isGarminHost(host)) return undefined;
    const parts: string[] = [];
    for (const { name, value, domain, host: cHost } of this.cookies.values()) {
      const owner = domain || cHost;
      if (host === owner || host.endsWith(`.${owner}`)) parts.push(`${name}=${value}`);
    }
    return parts.length ? parts.join('; ') : undefined;
  }

  valueFor(name: string): string | undefined {
    for (const c of this.cookies.values()) if (c.name === name) return c.value;
    return undefined;
  }

  toList(): StoredCookie[] {
    return [...this.cookies.values()];
  }

  static fromList(list: StoredCookie[]): CookieJar {
    const jar = new CookieJar();
    for (const c of list) {
      if (!isGarminHost(c.host)) continue;
      if (c.domain && !isAllowedDomain(c.domain, c.host)) continue;
      jar.cookies.set(`${c.name}@${c.domain || c.host}`, c);
    }
    return jar;
  }

  get size(): number {
    return this.cookies.size;
  }
}
