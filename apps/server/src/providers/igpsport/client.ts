/**
 * iGPSPORT private web-API client (international deployment: plain JWT, no
 * request signing).
 *
 * Auth: POST /service/auth/account/login
 *   {appId: "igpsport-web", username, password}
 *   → {access_token (JWT; `memberid` claim is the account id), refresh_token,
 *      expires_in}. The web client re-logins on expiry — there is no
 *   independently documented refresh endpoint, so Stridash persists the
 *   account password AES-256-GCM encrypted and re-authenticates when the JWT
 *   expires (documented in docs/igpsport.md under Security).
 *
 * Data model: `GET queryMyActivity` pages over list rows (id, title, times,
 * distance, ascent — but no HR/power), and the per-ride FIT file is the
 * source of truth for everything else. Responses use an envelope
 * `{code: 0, data}` where code 0 = success.
 */

import type { IgpSportRegion } from "./regions.js";

// ─── Path constants ──────────────────────────────────────────────────────────

export const PATH_LOGIN = "/service/auth/account/login";
export const PATH_QUERY_ACTIVITY = "/service/web-gateway/web-analyze/activity/queryMyActivity";
export const PATH_ACTIVITY_DETAIL = (rideId: string) =>
  `/service/web-gateway/web-analyze/activity/queryActivityDetail/${rideId}`;
export const PATH_DOWNLOAD_URL = (rideId: string) =>
  `/service/web-gateway/web-analyze/activity/getDownloadUrl/${rideId}`;

// ─── Errors ──────────────────────────────────────────────────────────────────

export class IgpSportError extends Error {
  readonly status?: number;
  readonly detail?: unknown;
  constructor(message: string, status?: number, detail?: unknown) {
    super(message);
    this.name = "IgpSportError";
    this.status = status;
    this.detail = detail;
  }
}

export class IgpSportNotLoggedInError extends IgpSportError {}

// ─── Shapes ──────────────────────────────────────────────────────────────────

export interface IgpSportActivityRow {
  rideId: string | number;
  title?: string;
  name?: string;
  /** "YYYY-MM-DD HH:MM:SS" (server-local, no offset!) — prefer FIT timestamps */
  startTime?: string;
  rideDistance?: number; // metres
  avgSpeed?: number; // m/s
  maxSpeed?: number;
  totalMovingTime?: number; // seconds
  recordTime?: number;
  totalAscent?: number;
  totalDescent?: number;
  exerciseType?: number; // 0 = cycling
  maxAlt?: number;
  minAlt?: number;
  [key: string]: unknown;
}

export interface IgpSportLoginResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Read claims from an unverified access JWT (we only need `memberid` / `exp`
 * for identity + expiry; signature enforcement upstream is done by iGPSPORT).
 */
export function peekJwtClaims(jwtToken: string): { memberId: string; exp: number | null } {
  try {
    const payload = JSON.parse(
      Buffer.from(jwtToken.split(".")[1] ?? "", "base64url").toString("utf8"),
    );
    return {
      memberId: String(payload.memberid ?? ""),
      exp: typeof payload.exp === "number" ? payload.exp : null,
    };
  } catch {
    return { memberId: "", exp: null };
  }
}

// ─── Client ──────────────────────────────────────────────────────────────────

export class IgpSportClient {
  readonly region: IgpSportRegion;
  private accessToken: string = "";

  constructor(region: IgpSportRegion) {
    if (region.signing) {
      throw new IgpSportError(
        "iGPSPORT CN accounts are not supported yet (they require executing the web client's WASM request-signer). Use an international (app.igpsport.com) account.",
      );
    }
    this.region = region;
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    return {
      Accept: "application/json, text/plain, */*",
      "User-Agent": `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Stridash/0.1`,
      Origin: this.region.origin,
      Referer: this.region.referer,
      "qiWu-app-version-echo": this.region.appVersion, // harmless: unrecognized headers are ignored
      "qiwu-app-version": this.region.appVersion,
      ...(this.region.accessKey ? { "x-access-key": this.region.accessKey } : {}),
      ...(this.region.platform ? { "x-platform": this.region.platform } : {}),
      ...(this.accessToken ? { Authorization: `Bearer ${this.accessToken}` } : {}),
      ...extra,
    };
  }

  private async request(path: string, init?: RequestInit): Promise<any> {
    const res = await fetch(this.region.apiBase + path, {
      ...init,
      headers: { ...this.headers(), ...((init?.headers as Record<string, string>) ?? {}) },
    });
    const json: any = await res.json().catch(() => {
      throw new IgpSportError(`Invalid JSON from iGPSPORT (HTTP ${res.status}) on ${path}`, res.status);
    });
    if (!res.ok) throw new IgpSportError(`iGPSPORT HTTP ${res.status} on ${path}`, res.status, json);
    if (typeof json.code !== "number") {
      throw new IgpSportError(`Unexpected envelope from iGPSPORT ${path}`, res.status, json);
    }
    if (json.code !== 0) {
      throw new IgpSportError(
        `iGPSPORT business error ${json.code} on ${path}: ${json.message ?? json.msg ?? ""}`,
        res.status === 200 ? 200 : res.status,
        { code: json.code, message: json.message ?? json.msg },
      );
    }
    return json.data;
  }

  // ── Auth ───────────────────────────────────────────────────────────────────

  /** Login and return the fresh token pair (access JWT, optional refresh). */
  async login(username: string, password: string): Promise<IgpSportLoginResponse> {
    const res = await fetch(this.region.apiBase + PATH_LOGIN, {
      method: "POST",
      headers: {
        ...this.headers(),
        "Content-Type": "application/json",
        Authorization: "", // never send a stale JWT to the login endpoint
      },
      body: JSON.stringify({ appId: this.region.loginAppId, username, password }),
    });
    const json: any = await res.json().catch(() => null);
    const data = json?.data;
    if (!res.ok || json?.code !== 0 || !data?.access_token) {
      const providerMessage = json?.message ?? json?.msg ?? null;
      throw new IgpSportError(
        `iGPSPORT login failed${providerMessage ? `: ${providerMessage}` : " (check username/password/region)"}`,
        res.status,
        providerMessage ? { providerMessage } : null,
      );
    }
    this.accessToken = data.access_token;
    return data as IgpSportLoginResponse;
  }

  /** Resume an authenticated session with a stored access token. */
  withAccessToken(accessToken: string): this {
    this.accessToken = accessToken;
    return this;
  }

  currentToken(): string {
    return this.accessToken;
  }

  // ── Activities ─────────────────────────────────────────────────────────────

  /** One page of activity list rows (newest first). */
  async listActivities(pageNo = 1, pageSize = 20): Promise<IgpSportActivityRow[]> {
    const path = `${PATH_QUERY_ACTIVITY}?pageNo=${pageNo}&pageSize=${pageSize}&reqType=0&sort=1`;
    const data = await this.request(path);
    const rows = Array.isArray(data)
      ? data
      : ((data?.rows ?? data?.list ?? []) as IgpSportActivityRow[]);
    return rows;
  }

  /** Server-side activity detail (includes fitUrl on the intl deployment). */
  async getActivityDetail(rideId: string): Promise<Record<string, any>> {
    return this.request(PATH_ACTIVITY_DETAIL(rideId));
  }

  /** Presigned OSS URL for the FIT file (not a Stridash-API-hosted URL). */
  async getFitDownloadUrl(rideId: string): Promise<string | null> {
    const data = await this.request(PATH_DOWNLOAD_URL(rideId));
    const url = typeof data === "string" ? data : data?.url;
    return url ?? null;
  }

  /** Download FIT binary via the presigned OSS link (no JWT needed there). */
  async downloadFit(rideId: string): Promise<Buffer> {
    const url = await this.getFitDownloadUrl(rideId);
    if (!url) throw new IgpSportError(`No FIT download URL for ride ${rideId}`);
    const res = await fetch(url);
    if (!res.ok) throw new IgpSportError(`FIT download failed (HTTP ${res.status}) for ride ${rideId}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 12 || buf.subarray(8, 12).toString("ascii") !== ".FIT") {
      throw new IgpSportError(`Downloaded file for ride ${rideId} is not a FIT file`);
    }
    return buf;
  }
}
