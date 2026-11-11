/**
 * Minimal cookie jar for the Garmin SSO flows.
 *
 * Node's fetch does no cookie handling, and the SSO login depends on session
 * cookies set while walking the sign-in pages (SESSION, __cf_bm, JWT_WEB, …).
 * Garmin only ever needs *garmin.com* suffix matching plus host-only cookies,
 * so a simple name/domain bag is enough — no full RFC 6265 parser.
 */

export interface StoredCookie {
  name: string;
  value: string;
  /** Empty string ⇒ host-only cookie for `origin`'s host. */
  domain: string;
  /** Origin host the cookie was received from (used when domain is empty). */
  host: string;
}

export class CookieJar {
  private cookies = new Map<string, StoredCookie>();

  /** Merge every Set-Cookie of a response under the URL's host. */
  capture(url: URL, response: Response): void {
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
      // key: replacing a cookie never keyed on path (Garmin uses "/")
      this.cookies.set(`${name}@${domain || url.hostname}`, {
        name,
        value,
        domain,
        host: url.hostname,
      });
    }
  }

  /** Cookie header for the URL (browser-style suffix matching). */
  headerFor(url: URL): string | undefined {
    const host = url.hostname;
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
    for (const c of list) jar.cookies.set(`${c.name}@${c.domain || c.host}`, c);
    return jar;
  }

  get size(): number {
    return this.cookies.size;
  }
}
