/**
 * Garmin SSO pure-function helpers: widget MFA var parsing, page title.
 * (Flow logic is covered live during real-account E2E; Google-style HTML
 * fixtures below come from the widget pages documented in python-garminconnect.)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DI_TOKEN_URL,
  exchangeServiceTicket,
  GarminError,
  parseWidgetMfaVars,
  pageTitle,
  peekJwtExpMs,
  refreshDiToken,
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
