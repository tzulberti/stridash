/**
 * Garmin SSO credential login — a TypeScript port of the 5-strategy chain in
 * python-garminconnect's client/sso.py:
 *
 *   1. Mobile iOS flow  (JSON credential POST to /mobile/api/login)
 *   2. SSO embed widget (HTML form POST to /sso/signin — bypasses the
 *      clientId-scoped rate buckets the JSON flows use)
 *   3. Portal web flow  (JSON credential POST to /portal/api/login)
 *
 * Differences from the Python original are deliberate and documented here:
 *  - No curl_cffi TLS impersonation (browser-fingerprint spoofing is not
 *    realistically achievable with undici's TLS stack). The three strategy
 *    *families* are kept because each lands in a different rate-limit bucket;
 *    the per-fingerprint rotation profiles are not.
 *  - Anti-WAF delays are kept (they load the GET→POST rhythm as much as the
 *    fingerprint does), but capped: mobile 2–5 s, widget 3–8 s, portal 10–20 s.
 *  - Only the DI OAuth2 token exchange is used for session establishment; the
 *    legacy JWT_WEB cookie fallback is intentionally not implemented (it
 *    requires SSO/TGT cookie babysitting and is the first thing Garmin
 *    deprecates when they rework auth).
 *
 * Garmin MAY break any of this at any time — they changed the flow in 2025,
 * which is why matin/garth deprecated its login. Provider errors are surfaced
 * verbatim (the same way the iGPSPORT client does) so live debugging is easy.
 */

import { CookieJar, type StoredCookie } from './cookie-jar.js';

// ─── Constants (mirror python-garminconnect client/constants.py) ─────────────

export const SSO_BASE = 'https://sso.garmin.com';
export const IOS_SSO_CLIENT_ID = 'GCM_IOS_DARK';
export const IOS_SERVICE_URL = 'https://mobile.integration.garmin.com/gcm/ios';
export const IOS_LOGIN_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) ' +
  'AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';
export const PORTAL_SSO_CLIENT_ID = 'GarminConnect';
export const PORTAL_SERVICE_URL = 'https://connect.garmin.com/app';
export const DESKTOP_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// Native API (connectapi.garmin.com) identity for the DI token exchange.
export const DI_TOKEN_URL = 'https://diauth.garmin.com/di-oauth2-service/oauth/token';
export const DI_GRANT_TYPE =
  'https://connectapi.garmin.com/di-oauth2-service/oauth/grant/service_ticket';
export const DI_CLIENT_IDS = [
  'GARMIN_CONNECT_MOBILE_ANDROID_DI_2025Q2',
  'GARMIN_CONNECT_MOBILE_ANDROID_DI_2024Q4',
  'GARMIN_CONNECT_MOBILE_ANDROID_DI',
  'GARMIN_CONNECT_MOBILE_IOS_DI',
] as const;
export const NATIVE_API_UA = 'GCM-Android-5.23';
export const NATIVE_X_GARMIN_UA =
  'com.garmin.android.apps.connectmobile/5.23; ; Google/sdk_gphone64_arm64/google; ' +
  'Android/33; Dalvik/2.1.0';
export const CONNECTAPI_BASE = 'https://connectapi.garmin.com';

// Anti-WAF delay bounds (seconds)
const MOBILE_DELAY = [2_000, 5_000] as const;
const WIDGET_DELAY = [3_000, 8_000] as const;
const PORTAL_DELAY = [10_000, 20_000] as const;

// Regexes (constants.py)
const CSRF_RE = /name="_csrf"\s+value="(.+?)"/;
const TITLE_RE = /<title>(.+?)<\/title>/;
const TICKET_RE = /\?ticket=(ST-[^"&\s]+)/;
const WIDGET_MFA_VARS_RE =
  /var\s+(customerGuid|mfaMethod|locale|clientId|codeSentTo)\s*=\s*"([^"]*)"\s*;/g;

/** Statuses Garmin answers with when it blocks a login attempt. */
const BLOCKED_STATUSES = new Set([427, 429]);

// ─── Errors ──────────────────────────────────────────────────────────────────

export type GarminErrorKind = 'CREDENTIALS' | 'MFA_REQUIRED' | 'RATE_LIMITED' | 'CONNECTION';

export class GarminError extends Error {
  kind: GarminErrorKind;
  /** Non-secret provider detail (status / responseStatus type). */
  detail?: string;

  constructor(kind: GarminErrorKind, message: string, detail?: string) {
    super(message);
    this.kind = kind;
    this.detail = detail;
  }
}

// ─── Widget MFA page variables ───────────────────────────────────────────────

export interface WidgetMfaVars {
  customerGuid?: string;
  mfaMethod?: string;
  locale?: string;
  clientId?: string;
  codeSentTo?: string;
}

export function parseWidgetMfaVars(html: string): WidgetMfaVars {
  const vars: WidgetMfaVars = {};
  for (const m of html.matchAll(WIDGET_MFA_VARS_RE)) vars[m[1] as keyof WidgetMfaVars] = m[2];
  return vars;
}

export function pageTitle(html: string): string {
  return TITLE_RE.exec(html)?.[1] ?? '';
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function randomBetween(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// ─── MFA context (the pending half-login) ────────────────────────────────────

/**
 * Everything needed to finish a login that hit MFA_REQUIRED: the SSO session
 * cookies, the request parameters of the flow, and (widget) the CSRF token.
 * Contains session-level secrets — treat as encrypted-at-rest material.
 */
export interface MfaContext {
  flow: 'mobile' | 'widget' | 'portal';
  cookies: StoredCookie[];
  params: Record<string, string>;
  /** mfaLastMethodUsed (mobile/portal) or widget's mfaMethod var. */
  method: string;
  /** Widget-only: CSRF token for the verifyMFA form post. */
  widgetCsrf?: string;
  serviceUrl: string;
  postHeaders: Record<string, string>;
}

// ─── Login result ────────────────────────────────────────────────────────────

export interface ServiceTicket {
  ticket: string;
  serviceUrl: string;
  cookies: StoredCookie[];
}

interface SsoJsonResponse {
  responseStatus?: { type?: string };
  serviceTicketId?: string;
  customerMfaInfo?: { mfaLastMethodUsed?: string };
  error?: { 'status-code'?: string };
}

async function fetchWith(
  url: string,
  init: RequestInit & { jar: CookieJar },
  timeoutMs = 30_000,
): Promise<Response> {
  const target = new URL(url);
  const cookie = init.jar.headerFor(target);
  const headers: Record<string, string> = {
    ...((init.headers as Record<string, string> | undefined) ?? {}),
  };
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(url, {
    ...init,
    headers,
    signal: AbortSignal.timeout(timeoutMs),
    redirect: init.redirect ?? 'manual',
  });
  init.jar.capture(target, res);
  return res;
}

const FORM = 'application/x-www-form-urlencoded';

function raiseIfBlocked(status: number, what: string): void {
  if (BLOCKED_STATUSES.has(status)) {
    throw new GarminError(
      'RATE_LIMITED',
      `${what} returned ${status} — rate limited or bot-flagged by Garmin (can be triggered by the client fingerprint, not only the IP)`,
      `HTTP ${status}`,
    );
  }
}

// ─── Ticket capture from the shared JSON flows ───────────────────────────────

interface JsonFlowSpec {
  label: string;
  kind: 'mobile' | 'portal';
  loginUrl: string;
  params: Record<string, string>;
  headers: Record<string, string>;
  serviceUrl: string;
}

/**
 * POST credentials and act on Garmin's responseStatus (shared by the mobile
 * and portal flows). On SUCCESSFUL a service ticket is captured by following
 * the redirect Garmin hands back; on MFA_REQUIRED the pending context is
 * returned instead of raising, because MFA resolution continues the same
 * SSO session via the REST verifyCode endpoints.
 */
async function postCredentials(
  jar: CookieJar,
  spec: JsonFlowSpec,
  email: string,
  password: string,
): Promise<ServiceTicket | MfaContext> {
  const res = await fetchWith(spec.loginUrl, {
    method: 'POST',
    jar,
    headers: spec.headers,
    body: JSON.stringify({ username: email, password, rememberMe: true, captchaToken: '' }),
  });
  raiseIfBlocked(res.status, spec.label);
  if (res.status === 403) {
    throw new GarminError(
      'CONNECTION',
      `${spec.label}: HTTP 403 (Cloudflare bot challenge)`,
      'HTTP 403',
    );
  }
  if (res.status >= 400) {
    throw new GarminError(
      'CONNECTION',
      `${spec.label} failed: HTTP ${res.status}`,
      `HTTP ${res.status}`,
    );
  }

  let json: SsoJsonResponse;
  try {
    json = (await res.json()) as SsoJsonResponse;
  } catch {
    throw new GarminError('CONNECTION', `${spec.label} failed (non-JSON): HTTP ${res.status}`);
  }

  const type = json.responseStatus?.type;

  if (type === 'MFA_REQUIRED') {
    return {
      flow: spec.kind,
      cookies: jar.toList(),
      params: spec.params,
      method: json.customerMfaInfo?.mfaLastMethodUsed ?? 'email',
      serviceUrl: spec.serviceUrl,
      postHeaders: spec.headers,
    };
  }

  if (type === 'SUCCESSFUL' && json.serviceTicketId) {
    // The JSON flows answer with a ticket id directly (no redirect chain).
    return { ticket: json.serviceTicketId, serviceUrl: spec.serviceUrl, cookies: jar.toList() };
  }

  if (type === 'INVALID_USERNAME_PASSWORD') {
    throw new GarminError(
      'CREDENTIALS',
      'Invalid username or password',
      '401 Unauthorized (INVALID_USERNAME_PASSWORD)',
    );
  }

  if (json.error?.['status-code'] === '429') {
    throw new GarminError('RATE_LIMITED', `${spec.label}: 429 in JSON body`, 'HTTP 429');
  }

  if (type === 'CAPTCHA_REQUIRED') {
    throw new GarminError('CONNECTION', `${spec.label}: CAPTCHA required (bot challenge)`, type);
  }

  throw new GarminError(
    'CONNECTION',
    `${spec.label} failed: HTTP ${res.status}, responseStatus=${type ?? 'unknown'}`,
    type ?? 'unknown',
  );
}

// ─── Strategies ──────────────────────────────────────────────────────────────

/** Strategy 1 — Mobile iOS (sso.garmin.com/mobile). */
async function mobileLogin(
  jar: CookieJar,
  email: string,
  password: string,
  opts: { delayMs?: number } = {},
): Promise<ServiceTicket | MfaContext> {
  const signinPath = `${SSO_BASE}/mobile/sso/en_US/sign-in`;
  const signinParams: Record<string, string> = {
    clientId: IOS_SSO_CLIENT_ID,
    service: IOS_SERVICE_URL,
  };
  const signinQs = new URLSearchParams(signinParams).toString();

  const page = await fetchWith(`${signinPath}?${signinQs}`, {
    jar,
    headers: {
      'User-Agent': IOS_LOGIN_UA,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });
  raiseIfBlocked(page.status, 'Mobile sign-in page GET');
  if (page.status === 403) {
    throw new GarminError(
      'CONNECTION',
      'Mobile sign-in page: HTTP 403 (Cloudflare bot challenge)',
      'HTTP 403',
    );
  }

  await sleep(opts.delayMs ?? randomBetween(...MOBILE_DELAY));

  return postCredentials(
    jar,
    {
      label: 'Mobile login',
      kind: 'mobile',
      loginUrl:
        `${SSO_BASE}/mobile/api/login?` +
        new URLSearchParams({
          clientId: IOS_SSO_CLIENT_ID,
          locale: 'en-US',
          service: IOS_SERVICE_URL,
        }).toString(),
      params: { clientId: IOS_SSO_CLIENT_ID, locale: 'en-US', service: IOS_SERVICE_URL },
      headers: {
        'User-Agent': IOS_LOGIN_UA,
        Accept: 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Content-Type': 'application/json',
        Origin: SSO_BASE,
        Referer: `${signinPath}?${signinQs}`,
      },
      serviceUrl: IOS_SERVICE_URL,
    },
    email,
    password,
  );
}

/** Strategy 2 — SSO embed widget (HTML form, its own rate bucket). */
async function widgetLogin(
  jar: CookieJar,
  email: string,
  password: string,
  opts: { delayMs?: number } = {},
): Promise<ServiceTicket | MfaContext> {
  const ssoBase = `${SSO_BASE}/sso`;
  const ssoEmbed = `${ssoBase}/embed`;
  const embedParams = { id: 'gauth-widget', embedWidget: 'true', gauthHost: ssoBase };
  const signinParams: Record<string, string> = {
    ...embedParams,
    gauthHost: ssoEmbed,
    service: ssoEmbed,
    source: ssoEmbed,
    redirectAfterAccountLoginUrl: ssoEmbed,
    redirectAfterAccountCreationUrl: ssoEmbed,
  };
  const embedQs = new URLSearchParams(embedParams).toString();
  const signinQs = new URLSearchParams(signinParams).toString();

  // Step 1: GET embed page to establish session cookies
  const embed = await fetchWith(`${ssoEmbed}?${embedQs}`, { jar });
  raiseIfBlocked(embed.status, 'Widget embed GET');
  if (!embed.ok) {
    throw new GarminError(
      'CONNECTION',
      `Widget embed returned ${embed.status}`,
      `HTTP ${embed.status}`,
    );
  }

  // Step 2: GET signin page for the CSRF token
  const signinGet = await fetchWith(`${ssoBase}/signin?${signinQs}`, {
    jar,
    headers: { Referer: ssoEmbed },
  });
  raiseIfBlocked(signinGet.status, 'Widget signin GET');
  const csrfMatch = CSRF_RE.exec(await signinGet.text());
  if (!csrfMatch) throw new GarminError('CONNECTION', 'Widget login: missing CSRF token');

  await sleep(opts.delayMs ?? randomBetween(...WIDGET_DELAY));

  // Step 3: POST credentials as an HTML form
  const post = await fetchWith(`${ssoBase}/signin?${signinQs}`, {
    jar,
    method: 'POST',
    headers: {
      'Content-Type': FORM,
      'User-Agent': DESKTOP_UA,
      Referer: signinGet.url ?? `${ssoBase}/signin`,
    },
    body: new URLSearchParams({
      username: email,
      password,
      embed: 'true',
      _csrf: csrfMatch[1] ?? '',
    }).toString(),
  });
  raiseIfBlocked(post.status, 'Widget signin POST');
  const html = await post.text();
  const title = pageTitle(html).toLowerCase();

  // Server errors → fall through the chain
  if (
    ['bad gateway', 'service unavailable', 'cloudflare', '502', '503'].some((h) =>
      title.includes(h),
    )
  ) {
    throw new GarminError('CONNECTION', `Widget login: server error '${title}'`);
  }

  // Credential errors — stop the chain early
  if (['locked', 'invalid', 'incorrect', 'account error'].some((h) => title.includes(h))) {
    throw new GarminError('CREDENTIALS', `Widget authentication failed: '${title}'`);
  }

  // MFA — detect via the inline JS vars (the signin page's own title is also
  // "GARMIN Authentication Application", so the title alone can't be trusted).
  const mfaVars = parseWidgetMfaVars(html);
  const mfaMethod = mfaVars.mfaMethod?.toLowerCase() ?? '';
  const looksLikeMfa =
    title.includes('mfa') || (title.includes('authentication application') && !!mfaMethod);
  if (looksLikeMfa) {
    // Email/SMS MFA pages may not send the code during the credential POST;
    // trigger delivery with the same endpoint the "Resend code" link uses.
    if ((mfaMethod === 'email' || mfaMethod === 'sms') && !mfaVars.codeSentTo) {
      const codeReq = await fetchWith(`${ssoBase}/verifyMFA/mfaCode`, {
        jar,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/plain, */*',
          Referer: post.url ?? `${ssoBase}/signin`,
        },
        body: JSON.stringify({
          customerGuid: mfaVars.customerGuid ?? '',
          mfaMethod: mfaVars.mfaMethod ?? '',
          locale: mfaVars.locale ?? '',
        }),
      });
      raiseIfBlocked(codeReq.status, 'Widget MFA code request');
    }
    const csrf2 = CSRF_RE.exec(html)?.[1];
    return {
      flow: 'widget',
      cookies: jar.toList(),
      params: signinParams,
      method: mfaVars.mfaMethod ?? '',
      widgetCsrf: csrf2 ?? undefined,
      serviceUrl: ssoEmbed,
      postHeaders: { Referer: post.url ?? `${ssoBase}/signin` },
    };
  }

  if (title !== 'success') {
    throw new GarminError('CONNECTION', `Widget login: unexpected title '${title}'`);
  }

  // Step 4: service ticket (may appear under any service URL)
  const ticketMatch = TICKET_RE.exec(html);
  if (!ticketMatch) throw new GarminError('CONNECTION', 'Widget login: missing service ticket');
  return { ticket: ticketMatch[1]!, serviceUrl: ssoEmbed, cookies: jar.toList() };
}

/** Strategy 3 — Portal web (/portal — desktop browser flow). */
async function portalLogin(
  jar: CookieJar,
  email: string,
  password: string,
  opts: { delayMs?: number } = {},
): Promise<ServiceTicket | MfaContext> {
  const signinPath = `${SSO_BASE}/portal/sso/en-US/sign-in`;
  const signinParams: Record<string, string> = {
    clientId: PORTAL_SSO_CLIENT_ID,
    service: PORTAL_SERVICE_URL,
  };
  const signinQs = new URLSearchParams(signinParams).toString();

  const page = await fetchWith(`${signinPath}?${signinQs}`, {
    jar,
    headers: {
      'User-Agent': DESKTOP_UA,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });
  raiseIfBlocked(page.status, 'Portal sign-in page GET');
  if (page.status === 403) {
    throw new GarminError(
      'CONNECTION',
      'Portal sign-in page: HTTP 403 (Cloudflare bot challenge)',
      'HTTP 403',
    );
  }

  // 10–20 s mimics a real browser "read then type" rhythm
  await sleep(opts.delayMs ?? randomBetween(...PORTAL_DELAY));

  return postCredentials(
    jar,
    {
      label: 'Portal login',
      kind: 'portal',
      loginUrl:
        `${SSO_BASE}/portal/api/login?` +
        new URLSearchParams({
          clientId: PORTAL_SSO_CLIENT_ID,
          locale: 'en-US',
          service: PORTAL_SERVICE_URL,
        }).toString(),
      params: { clientId: PORTAL_SSO_CLIENT_ID, locale: 'en-US', service: PORTAL_SERVICE_URL },
      headers: {
        'User-Agent': DESKTOP_UA,
        Accept: 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Content-Type': 'application/json',
        Origin: SSO_BASE,
        Referer: `${signinPath}?${signinQs}`,
      },
      serviceUrl: PORTAL_SERVICE_URL,
    },
    email,
    password,
  );
}

// ─── Public login API ────────────────────────────────────────────────────────

export type LoginOutcome = ServiceTicket | MfaContext;

export function isMfaContext(outcome: LoginOutcome): outcome is MfaContext {
  return 'flow' in outcome && outcome.flow !== 'portal';
}

/** One strategy chain pass. Only credential errors stop the chain. */
export async function garminSsoLogin(
  email: string,
  password: string,
  opts: { delayMs?: number } = {},
): Promise<LoginOutcome> {
  const strategies = [
    { label: 'mobile', run: () => mobileLogin(new CookieJar(), email, password, opts) },
    { label: 'widget', run: () => widgetLogin(new CookieJar(), email, password, opts) },
    { label: 'portal', run: () => portalLogin(new CookieJar(), email, password, opts) },
  ];

  let lastError: GarminError | null = null;
  let rateLimited = 0;

  for (const s of strategies) {
    try {
      return await s.run();
    } catch (err) {
      if (err instanceof GarminError) {
        if (err.kind === 'CREDENTIALS') throw err; // stop immediately
        if (err.kind === 'RATE_LIMITED') rateLimited++;
        lastError = err;
        continue;
      }
      lastError = new GarminError('CONNECTION', `${s.label} failed: ${String(err)}`);
      continue;
    }
  }

  if (rateLimited === strategies.length) {
    throw new GarminError(
      'RATE_LIMITED',
      'All login strategies rate limited or blocked (HTTP 429/427). Garmin may be blocking this client or network rather than rate limiting; try again later or from another network.',
    );
  }
  throw lastError ?? new GarminError('CONNECTION', 'All login strategies exhausted');
}

// ─── MFA completion ──────────────────────────────────────────────────────────

/** Complete widget-flow MFA: POST the code to the verifyMFA HTML form. */
async function completeMfaWidget(ctx: MfaContext, code: string): Promise<ServiceTicket> {
  if (!ctx.widgetCsrf) throw new GarminError('MFA_REQUIRED', 'Widget MFA: missing CSRF token');
  const jar = CookieJar.fromList(ctx.cookies);
  const signinQs = new URLSearchParams(ctx.params).toString();

  const res = await fetchWith(`${SSO_BASE}/sso/verifyMFA/loginEnterMfaCode?${signinQs}`, {
    jar,
    method: 'POST',
    headers: {
      'Content-Type': FORM,
      'User-Agent': DESKTOP_UA,
      ...ctx.postHeaders,
    },
    body: new URLSearchParams({
      'mfa-code': code,
      embed: 'true',
      _csrf: ctx.widgetCsrf,
      fromPage: 'setupEnterMfaCode',
    }).toString(),
  });
  raiseIfBlocked(res.status, 'Widget MFA verify');

  const html = await res.text();
  const title = pageTitle(html);
  if (title !== 'Success') {
    throw new GarminError('CREDENTIALS', `Widget MFA failed: ${title}`);
  }
  const ticketMatch = TICKET_RE.exec(html);
  if (!ticketMatch) throw new GarminError('MFA_REQUIRED', 'Widget MFA: missing service ticket');
  return { ticket: ticketMatch[1]!, serviceUrl: `${SSO_BASE}/sso/embed`, cookies: jar.toList() };
}

/**
 * Complete JSON-flow MFA (mobile/portal). Tries this flow's verifyCode
 * endpoint and then the other path's as fallback — they share the SSO
 * session cookies but sit in different rate-limit buckets.
 */
async function completeMfaJson(ctx: MfaContext, code: string): Promise<ServiceTicket> {
  const jar = CookieJar.fromList(ctx.cookies);
  const flowPath = ctx.flow === 'mobile' ? 'mobile' : ctx.flow === 'portal' ? 'portal' : 'mobile';
  const altPath = flowPath === 'portal' ? 'mobile' : 'portal';
  const altParams: Record<string, string> =
    altPath === 'portal'
      ? { clientId: PORTAL_SSO_CLIENT_ID, locale: 'en-US', service: PORTAL_SERVICE_URL }
      : { clientId: IOS_SSO_CLIENT_ID, locale: 'en-US', service: IOS_SERVICE_URL };
  const endpoints = [
    {
      url: `${SSO_BASE}/${flowPath}/api/mfa/verifyCode?${new URLSearchParams(ctx.params).toString()}`,
      params: ctx.params,
    },
    {
      url: `${SSO_BASE}/${altPath}/api/mfa/verifyCode?${new URLSearchParams(altParams).toString()}`,
      params: altParams,
    },
  ];
  const body = {
    mfaMethod: ctx.method || 'email',
    mfaVerificationCode: code,
    rememberMyBrowser: true,
    reconsentList: [],
    mfaSetup: false,
  };

  const failures: string[] = [];
  let rateLimited = 0;
  for (const ep of endpoints) {
    let res: Response;
    try {
      res = await fetchWith(ep.url, {
        jar,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/plain, */*',
          ...ctx.postHeaders,
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      failures.push(`${ep.url}: connection error ${String(err)}`);
      continue;
    }
    if (BLOCKED_STATUSES.has(res.status)) {
      failures.push(`HTTP ${res.status} on ${ep.url}`);
      rateLimited++;
      continue;
    }
    let json: SsoJsonResponse;
    try {
      json = (await res.json()) as SsoJsonResponse;
    } catch {
      // non-JSON is almost always a Cloudflare HTML challenge
      failures.push(`HTTP ${res.status} non-JSON on ${ep.url}`);
      continue;
    }
    if (json.error?.['status-code'] === '429') {
      failures.push(`429 in JSON body on ${ep.url}`);
      rateLimited++;
      continue;
    }
    if (json.responseStatus?.type === 'SUCCESSFUL' && json.serviceTicketId) {
      return { ticket: json.serviceTicketId, serviceUrl: ctx.serviceUrl, cookies: jar.toList() };
    }
    const status = json.responseStatus?.type ?? json.error?.['status-code'] ?? 'unknown';
    failures.push(`${status} on ${ep.url}`);
  }

  if (rateLimited === endpoints.length) {
    throw new GarminError(
      'RATE_LIMITED',
      `MFA verification rate limited on all endpoints: ${failures.join('; ')}`,
    );
  }
  throw new GarminError('CREDENTIALS', `MFA verification failed: ${failures.join('; ')}`);
}

/** Finish a pending MFA login — dispatches on the flow that started it. */
export async function completeMfa(ctx: MfaContext, code: string): Promise<ServiceTicket> {
  if (ctx.flow === 'widget') return completeMfaWidget(ctx, code);
  return completeMfaJson(ctx, code);
}

// ─── DI OAuth2 token exchange (CAS ticket → Bearer token) ────────────────────

export interface DiTokens {
  diToken: string;
  diRefreshToken?: string;
  diClientId: string;
}

/** Bearer token lifetime claim from a JWT payload. */
export function peekJwtExpMs(token: string): number | null {
  try {
    const payload = token.split('.')[1];
    if (!payload) return null;
    const json = JSON.parse(
      Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'),
    );
    return typeof json.exp === 'number' ? json.exp * 1000 : null;
  } catch {
    return null;
  }
}

function nativeHeaders(clientId: string, accept: string): Record<string, string> {
  return {
    Authorization: `Basic ${Buffer.from(`${clientId}:`).toString('base64')}`,
    Accept: accept,
    'Content-Type': 'application/x-www-form-urlencoded',
    'Cache-Control': 'no-cache',
    'User-Agent': NATIVE_API_UA,
    'x-garmin-user-agent': NATIVE_X_GARMIN_UA,
  };
}

/** Exchange a CAS service ticket for a native DI OAuth2 Bearer token. */
export async function exchangeServiceTicket(ticket: string, serviceUrl: string): Promise<DiTokens> {
  let lastStatus = 'unknown';
  for (const clientId of DI_CLIENT_IDS) {
    const res = await fetch(DI_TOKEN_URL, {
      method: 'POST',
      headers: nativeHeaders(clientId, 'application/json,text/html;q=0.9,*/*;q=0.8'),
      body: new URLSearchParams({
        client_id: clientId,
        service_ticket: ticket,
        grant_type: DI_GRANT_TYPE,
        service_url: serviceUrl,
      }).toString(),
      signal: AbortSignal.timeout(30_000),
    });
    if (res.status === 429) {
      throw new GarminError('RATE_LIMITED', 'DI token exchange rate limited', 'HTTP 429');
    }
    if (!res.ok) {
      lastStatus = `HTTP ${res.status}`;
      continue;
    }
    const data = (await res.json()) as { access_token?: string; refresh_token?: string };
    if (typeof data.access_token !== 'string' || !data.access_token) {
      lastStatus = 'missing access_token';
      continue;
    }
    return {
      diToken: data.access_token,
      diRefreshToken: data.refresh_token,
      diClientId: peekJwtExpMs(data.access_token) === null ? clientId : clientId,
    };
  }
  throw new GarminError(
    'CONNECTION',
    `DI token exchange failed for all client IDs (last: ${lastStatus}). The SSO login reached Garmin but the ticket could not be exchanged.`,
    lastStatus,
  );
}

/** Refresh a DI token with the stored refresh grant. */
export async function refreshDiToken(refreshToken: string, clientId: string): Promise<DiTokens> {
  const res = await fetch(DI_TOKEN_URL, {
    method: 'POST',
    headers: nativeHeaders(clientId, 'application/json'),
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: clientId,
      refresh_token: refreshToken,
    }).toString(),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    throw new GarminError(
      'CONNECTION',
      `DI token refresh failed: HTTP ${res.status} — reconnect the Garmin account`,
      `HTTP ${res.status}`,
    );
  }
  const data = (await res.json()) as { access_token?: string; refresh_token?: string };
  if (typeof data.access_token !== 'string' || !data.access_token) {
    throw new GarminError('CONNECTION', 'DI token refresh returned no access_token');
  }
  return {
    diToken: data.access_token,
    diRefreshToken: data.refresh_token ?? refreshToken,
    diClientId: clientId,
  };
}
