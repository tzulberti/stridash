/**
 * Garmin SSO helpers plus mocked full login/MFA chains (mobile, widget,
 * portal). Real Garmin/Cloudflare behavior is still verified live with a real
 * account; these fixtures pin the protocol/state-machine branches.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  completeMfa,
  DI_TOKEN_URL,
  exchangeServiceTicket,
  GarminError,
  garminSsoLogin,
  isMfaContext,
  parseWidgetMfaVars,
  pageTitle,
  peekJwtExpMs,
  refreshDiToken,
  type MfaContext,
} from '../src/providers/garmin/sso.js';

describe('parseWidgetMfaVars', () => {
  it('extracts the inline JS variables from the widget MFA page', () => {
    const html = `<script>
      var customerGuid = "1q2w3e4r-5t6y-7u8i";
      var mfaMethod    = "email";
      var locale       = "en-US";
      var clientId     = "gauth-widget";
      var codeSentTo   = "t***@mail.com";
    </script>`;
    expect(parseWidgetMfaVars(html)).toEqual({
      customerGuid: '1q2w3e4r-5t6y-7u8i',
      mfaMethod: 'email',
      locale: 'en-US',
      clientId: 'gauth-widget',
      codeSentTo: 't***@mail.com',
    });
  });

  it('returns an empty object when there are no MFA variables', () => {
    expect(parseWidgetMfaVars('<html><body /></html>')).toEqual({});
  });
});

describe('pageTitle', () => {
  it('reads the <title>', () => {
    expect(pageTitle('<head><title>Success</title></head>')).toBe('Success');
  });
  it("returns '' without a title", () => {
    expect(pageTitle('<head></head>')).toBe('');
  });
});

describe('peekJwtExpMs', () => {
  it('decodes the exp claim', () => {
    const payload = Buffer.from(JSON.stringify({ exp: 1_700_000_000, client_id: 'X' })).toString(
      'base64url',
    );
    expect(peekJwtExpMs(`abc.${payload}.def`)).toBe(1_700_000_000_000);
  });
  it('returns null on garbage', () => {
    expect(peekJwtExpMs('not-a-jwt')).toBeNull();
  });
});

describe('Garmin DI token exchange', () => {
  const fetchMock = vi.fn();
  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('exchanges the service ticket with the first accepted client id', async () => {
    fetchMock.mockResolvedValueOnce(json({ access_token: 'di-1', refresh_token: 'refresh-1' }));

    await expect(exchangeServiceTicket('ST-1', 'https://connect.garmin.com/app')).resolves.toEqual({
      diToken: 'di-1',
      diRefreshToken: 'refresh-1',
      diClientId: expect.any(String),
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(DI_TOKEN_URL);
    expect(init.method).toBe('POST');
    expect(new URLSearchParams(init.body).get('service_ticket')).toBe('ST-1');
  });

  it('rotates to the next client id after a non-rate-limit failure', async () => {
    fetchMock
      .mockResolvedValueOnce(json({}, 401))
      .mockResolvedValueOnce(json({ access_token: 'di-2' }));

    await expect(exchangeServiceTicket('ST-2', 'service')).resolves.toMatchObject({
      diToken: 'di-2',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('stops immediately on 429 and reports all-client failure', async () => {
    fetchMock.mockResolvedValueOnce(json({}, 429));
    await expect(exchangeServiceTicket('ST-3', 'service')).rejects.toMatchObject({
      kind: 'RATE_LIMITED',
      detail: 'HTTP 429',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockReset();
    fetchMock.mockImplementation(async () => json({}));
    await expect(exchangeServiceTicket('ST-4', 'service')).rejects.toMatchObject({
      kind: 'CONNECTION',
      detail: 'missing access_token',
    });
  });

  it('refreshes a DI token and keeps the old refresh token when omitted', async () => {
    fetchMock.mockResolvedValueOnce(json({ access_token: 'di-3' }));
    await expect(refreshDiToken('refresh-1', 'client-1')).resolves.toEqual({
      diToken: 'di-3',
      diRefreshToken: 'refresh-1',
      diClientId: 'client-1',
    });

    fetchMock.mockResolvedValueOnce(json({ access_token: 'di-4', refresh_token: 'refresh-2' }));
    await expect(refreshDiToken('refresh-1', 'client-1')).resolves.toMatchObject({
      diRefreshToken: 'refresh-2',
    });
  });

  it('surfaces refresh HTTP and missing-token failures', async () => {
    fetchMock.mockResolvedValueOnce(json({}, 500));
    const httpErr = await refreshDiToken('refresh-1', 'client-1').catch((e: unknown) => e);
    expect(httpErr).toBeInstanceOf(GarminError);
    expect(httpErr).toMatchObject({ kind: 'CONNECTION', detail: 'HTTP 500' });

    fetchMock.mockResolvedValueOnce(json({}));
    await expect(refreshDiToken('refresh-1', 'client-1')).rejects.toMatchObject({
      kind: 'CONNECTION',
      message: expect.stringContaining('no access_token'),
    });
  });
});

// ─── Full login/MFA state machine (mocked fetch) ─────────────────────────────

describe('Garmin SSO login chain', () => {
  const fetchMock = vi.fn();
  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  const html = (body: string, status = 200): Response =>
    new Response(body, { status, headers: { 'content-type': 'text/html' } });

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('logs in through the mobile JSON flow and posts the credentials', async () => {
    fetchMock
      .mockResolvedValueOnce(html('<html>sign in</html>'))
      .mockResolvedValueOnce(
        json({ responseStatus: { type: 'SUCCESSFUL' }, serviceTicketId: 'ST-mobile' }),
      );

    const outcome = await garminSsoLogin('rider@example.com', 'secret', { delayMs: 0 });

    expect(isMfaContext(outcome)).toBe(false);
    expect(outcome).toMatchObject({ ticket: 'ST-mobile' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url, init] = fetchMock.mock.calls[1]!;
    expect(String(url)).toContain('/mobile/api/login');
    expect(JSON.parse(String(init.body))).toMatchObject({
      username: 'rider@example.com',
      password: 'secret',
      rememberMe: true,
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('parks MFA_REQUIRED and completes the JSON verification', async () => {
    fetchMock.mockResolvedValueOnce(html('<html>sign in</html>')).mockResolvedValueOnce(
      json({
        responseStatus: { type: 'MFA_REQUIRED' },
        customerMfaInfo: { mfaLastMethodUsed: 'email' },
      }),
    );

    const pending = await garminSsoLogin('rider@example.com', 'secret', { delayMs: 0 });
    expect(isMfaContext(pending)).toBe(true);
    const ctx = pending as MfaContext;
    expect(ctx).toMatchObject({ flow: 'mobile', method: 'email' });

    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(
      json({ responseStatus: { type: 'SUCCESSFUL' }, serviceTicketId: 'ST-mfa' }),
    );

    await expect(completeMfa(ctx, '123456')).resolves.toMatchObject({ ticket: 'ST-mfa' });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain('/mobile/api/mfa/verifyCode');
    expect(JSON.parse(String(init.body))).toMatchObject({
      mfaMethod: 'email',
      mfaVerificationCode: '123456',
    });
  });

  it('stops the strategy chain on invalid credentials', async () => {
    fetchMock
      .mockResolvedValueOnce(html('<html>sign in</html>'))
      .mockResolvedValueOnce(json({ responseStatus: { type: 'INVALID_USERNAME_PASSWORD' } }));

    await expect(
      garminSsoLogin('rider@example.com', 'wrong', { delayMs: 0 }),
    ).rejects.toMatchObject({
      kind: 'CREDENTIALS',
      message: 'Invalid username or password',
    });
    // no widget/portal attempts after a definitive credential rejection
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('falls through mobile and widget to the portal flow', async () => {
    fetchMock
      // mobile: page OK, login → 500 (connection error)
      .mockResolvedValueOnce(html('<html>mobile</html>'))
      .mockResolvedValueOnce(json({}, 500))
      // widget: embed OK, signin page with CSRF, form POST → unexpected title
      .mockResolvedValueOnce(html('<html>embed</html>'))
      .mockResolvedValueOnce(html('<input name="_csrf" value="csrf-1">'))
      .mockResolvedValueOnce(html('<html><title>Error</title></html>'))
      // portal: page OK, login → SUCCESSFUL
      .mockResolvedValueOnce(html('<html>portal</html>'))
      .mockResolvedValueOnce(
        json({ responseStatus: { type: 'SUCCESSFUL' }, serviceTicketId: 'ST-portal' }),
      );

    const outcome = await garminSsoLogin('rider@example.com', 'secret', { delayMs: 0 });

    expect(outcome).toMatchObject({ ticket: 'ST-portal' });
    expect(fetchMock).toHaveBeenCalledTimes(7);
    expect(String(fetchMock.mock.calls[6]![0])).toContain('/portal/api/login');
  });

  it('completes widget-flow MFA from the HTML form response', async () => {
    const ctx: MfaContext = {
      flow: 'widget',
      cookies: [],
      params: { id: 'gauth-widget' },
      method: 'email',
      widgetCsrf: 'csrf-2',
      serviceUrl: 'https://sso.garmin.com/sso/embed',
      postHeaders: {},
    };
    fetchMock.mockResolvedValueOnce(
      html('<html><title>Success</title><a href="x?ticket=ST-widget&state=1">ok</a></html>'),
    );

    await expect(completeMfa(ctx, '654321')).resolves.toMatchObject({ ticket: 'ST-widget' });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain('/sso/verifyMFA/loginEnterMfaCode');
    expect(String(init.body)).toContain('mfa-code=654321');
    expect(String(init.body)).toContain('_csrf=csrf-2');
  });

  it('rejects a widget MFA context without a CSRF token', async () => {
    const ctx: MfaContext = {
      flow: 'widget',
      cookies: [],
      params: {},
      method: 'email',
      serviceUrl: 'https://sso.garmin.com/sso/embed',
      postHeaders: {},
    };

    await expect(completeMfa(ctx, '1')).rejects.toMatchObject({ kind: 'MFA_REQUIRED' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('surfaces fetch timeouts as a connection failure after exhausting the chain', async () => {
    fetchMock.mockRejectedValue(new DOMException('timeout', 'TimeoutError'));

    await expect(
      garminSsoLogin('rider@example.com', 'secret', { delayMs: 0 }),
    ).rejects.toMatchObject({
      kind: 'CONNECTION',
      message: expect.stringContaining('failed'),
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('reports RATE_LIMITED only when every strategy is blocked', async () => {
    fetchMock.mockResolvedValue(html('blocked', 429));

    await expect(
      garminSsoLogin('rider@example.com', 'secret', { delayMs: 0 }),
    ).rejects.toMatchObject({
      kind: 'RATE_LIMITED',
      message: expect.stringContaining('All login strategies'),
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
