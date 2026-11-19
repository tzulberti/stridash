import { describe, expect, it } from 'vitest';
import { CookieJar } from '../src/providers/garmin/cookie-jar.js';

function response(cookies: string[]): Response {
  return { headers: { getSetCookie: () => cookies } } as unknown as Response;
}

const SSO = new URL('https://sso.garmin.com/sso/signin');
const CONNECT = new URL('https://connect.garmin.com/modern');

describe('CookieJar domain restriction', () => {
  it('accepts garmin.com cookies and sends them to Garmin hosts', () => {
    const jar = new CookieJar();
    jar.capture(SSO, response(['SESSION=abc; Domain=.garmin.com; Path=/', 'JWT_WEB=xyz; Path=/']));

    expect(jar.headerFor(CONNECT)).toContain('SESSION=abc');
    // host-only cookie: only the origin host (browser semantics)
    expect(jar.headerFor(SSO)).toContain('JWT_WEB=xyz');
  });

  it('rejects a public-suffix Domain such as .com', () => {
    const jar = new CookieJar();
    jar.capture(SSO, response(['evil=1; Domain=.com; Path=/']));
    expect(jar.size).toBe(0);
    expect(jar.headerFor(new URL('https://example.com/'))).toBeUndefined();
  });

  it('rejects lookalike and unrelated domains', () => {
    const jar = new CookieJar();
    jar.capture(SSO, response(['a=1; Domain=evilgarmin.com', 'b=2; Domain=example.com']));
    expect(jar.size).toBe(0);
  });

  it('ignores responses from non-Garmin origins', () => {
    const jar = new CookieJar();
    jar.capture(new URL('https://evil.example/'), response(['SESSION=stolen; Path=/']));
    expect(jar.size).toBe(0);
    expect(jar.headerFor(SSO)).toBeUndefined();
  });

  it('never sends cookies to a non-Garmin host', () => {
    const jar = new CookieJar();
    jar.capture(SSO, response(['SESSION=abc; Domain=.garmin.com; Path=/']));
    expect(jar.headerFor(new URL('https://garmin.com.evil.example/'))).toBeUndefined();
  });

  it('filters a restored list through the same allowlist', () => {
    const jar = CookieJar.fromList([
      { name: 'ok', value: '1', domain: 'garmin.com', host: 'sso.garmin.com' },
      { name: 'bad', value: '2', domain: 'com', host: 'sso.garmin.com' },
      { name: 'foreign', value: '3', domain: '', host: 'evil.example' },
    ]);
    expect(jar.toList().map((c) => c.name)).toEqual(['ok']);
  });
});
