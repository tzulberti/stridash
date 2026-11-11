/**
 * OmronConnect API v1 client (Kii "app-server-code" protocol).
 *
 * Auth model: log in with the user's Omron account (email + password) at
 * `{cloudUrl}/oauth2/token` → { access_token, refresh_token }. Access tokens
 * are bearer tokens; refresh via `grant_type=refresh_token`. We persist only
 * the refresh token (never the password).
 *
 * Data model (v1): devices come from `synchronizeDeviceConfData`
 * (paginate over syncList); measurements come from `measureData`, returning a
 * `deviceModelList[].deviceSerialIDList[].measureList[]` where each sample has
 * `measureDateTo` (unix ms), `timeZone` (IANA) and a `bodyIndexList` map of
 * value code → [value, unitSubtype, scaleExp, measurementId].
 *
 * Native gzip bugs in some regional servers are tolerated by decompressing
 * defensively (see the fetch() wrapper).
 */

import { gunzipSync } from 'node:zlib';

import type { OmronRegion } from './regions.js';

// ─── Protocol constants ──────────────────────────────────────────────────────

export const OMRON_APP_VERSION = '011.004.00000'; // iOS OmronConnect build
export const OMRON_SDK_VERSION = '000.005';

export const USER_AGENT = `OmronConnect/${OMRON_APP_VERSION}.001 CFNetwork/1335.0.3.4 Darwin/21.6.0)`;

/** bodyIndexList value codes (units via `subtype`, precision via `scale`). */
export const Value = {
  // Blood pressure
  MMHG_MAX: '1', // systolic (mmHg; kPa when unit subtype says so)
  MMHG_MIN: '2', // diastolic
  BPM: '3', // pulse
  MMHG_MAP: '16', // mean arterial pressure
  ARRHYTHMIA_FLAG: '6',
  BODY_MOTION_FLAG: '7',
  POSTURE_GUIDE: '20',
  CUFF_WRAP_CHECK: '8',
  PULSE_QUIET_CHECK: '9',
  // Weight / body composition
  WEIGHT: '257', // %-str: kg|lb|st|g — disambiguated via `subtype`
  BODY_FAT_PCT: '259',
  BASAL_METABOLISM: '260', // kcal
  SKELETAL_MUSCLE_PCT: '261',
  METABOLIC_AGE: '263',
  VISCERAL_FAT_LEVEL: '264',
  VISCERAL_FAT_CHECK: '265',
  SKELETAL_MUSCLE_CHECK: '266',
  IMPEDANCE: '267', // ohm
  FAT_FREE_MASS: '268', // FFMI kg/m² (dimensionless, unit 0 — verified vs real data)
  AVG_WEIGHT: '269',
  AVG_WEIGHT_FFM: '270',
  BLE_BMI: '292',
  SKELETAL_MUSCLE_MASS: '294', // kg
  BODY_FAT_MASS: '295', // kg
  // Segmental (body parts)
  SEG_MUSCLE_ARMS: '275',
  SEG_MUSCLE_TRUNK: '277',
  SEG_MUSCLE_LEGS: '279',
  SEG_SUBCUT_FAT: '281',
  SEG_SUBCUT_FAT_ARMS: '283',
  SEG_SUBCUT_FAT_TRUNK: '285',
  SEG_SUBCUT_FAT_LEGS: '287',
  SEG_MUSCLE_CHECK_ARMS: '276',
  SEG_MUSCLE_CHECK_TRUNK: '278',
  SEG_MUSCLE_CHECK_LEGS: '280',
  SEG_SUBCUT_CHECK: '282',
  SEG_SUBCUT_CHECK_ARMS: '284',
  SEG_SUBCUT_CHECK_TRUNK: '286',
  SEG_SUBCUT_CHECK_LEGS: '288',
  BMI: '262',
} as const;

/** weight `subtype` unit codes. */
export const WeightUnit = {
  G: 8192,
  KG: 8195,
  LB: 8208,
  ST: 8224,
} as const;

/** Device categories. */
export const DeviceCategory = {
  BPM: '0',
  SCALE: '1',
} as const;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Internal shape of one bodyIndexList entry:
 * value code → [rawValue, unitSubtype, scaleExponent, measurementId].
 */
export type BodyIndexList = Record<string, [number, number, number, number]>;

/** Apply the protocol's decimal-point scaling: value * 10^scale. */
export function applyScale(value: number, scale: number): number {
  return value * Math.pow(10, scale);
}

/** Convert a weight to kg given the protocol's unit subtype code. */
export function weightToKg(value: number, unit: number): number {
  switch (unit) {
    case WeightUnit.G:
      return value / 1000;
    case WeightUnit.LB:
      return value * 0.45359237;
    case WeightUnit.ST:
      return value * 6.35029318;
    default: // WeightUnit.KG and anything unrecognised: assume kg
      return value;
  }
}

// ─── Client ──────────────────────────────────────────────────────────────────

export interface OmronTokens {
  accessToken: string;
  refreshToken: string;
}

export interface OmronDevice {
  /** e.g. "HBF-703T" */
  deviceModel: string;
  /** hex serial as used by the measure API (not the printed one). */
  deviceSerialID: string;
  /** 1-based user profile slot on the device. */
  userNumberInDevice: number;
  category: string; // DeviceCategory value
}

interface RawMeasureSample {
  measureDateTo: number;
  timeZone: string;
  bodyIndexList: BodyIndexList;
  [key: string]: unknown;
}

interface RawDeviceMeasurements {
  deviceSerialID: string;
  userNumberInDevice: number;
  measureList: RawMeasureSample[];
  [key: string]: unknown;
}

export class OmronConnectError extends Error {
  readonly status?: number;
  readonly detail?: unknown;

  constructor(message: string, status?: number, detail?: unknown) {
    super(message);
    this.name = 'OmronConnectError';
    this.status = status;
    this.detail = detail;
  }
}

export class OmronConnectV1 {
  readonly region: OmronRegion;
  private accessToken: string = '';
  private onTokensRefreshed?: (tokens: OmronTokens) => void | Promise<void>;

  constructor(
    region: OmronRegion,
    opts?: { onTokensRefreshed?: (tokens: OmronTokens) => void | Promise<void> },
  ) {
    this.region = region;
    this.onTokensRefreshed = opts?.onTokensRefreshed;
  }

  private appUrl(): string {
    return `${this.region.cloudUrl}/apps/${this.region.appId}/server-code`;
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    const h: Record<string, string> = {
      'User-Agent': USER_AGENT,
      'X-OGSC-SDK-Version': OMRON_SDK_VERSION,
      'X-OGSC-App-Version': OMRON_APP_VERSION,
      'X-Kii-AppID': this.region.appId,
      'X-Kii-AppKey': this.region.appKey,
      ...extra,
    };
    if (this.accessToken) h.Authorization = `Bearer ${this.accessToken}`;
    return h;
  }

  /**
   * Some regional Omron servers emit a Content-Encoding: gzip header while
   * sending plain UTF-8 (and vice versa). sniff the gzip magic bytes and
   * decompress only when actually gzipped, rather than trusting the header.
   */
  private async parseBody(res: Response): Promise<unknown> {
    if (!res.body) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    let text: string;
    if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
      text = gunzipSync(buf).toString('utf8');
    } else {
      text = buf.toString('utf8');
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new OmronConnectError(`Invalid JSON from Omron API (HTTP ${res.status})`, res.status, {
        preview: text.slice(0, 300),
      });
    }
    return json;
  }

  private async post(path: string, payload: unknown): Promise<any> {
    const res = await fetch(path.startsWith('http') ? path : this.appUrl() + path, {
      method: 'POST',
      headers: {
        ...this.headers(),
        'Content-Type': 'application/vnd.kii+json;charset=utf-8',
      },
      body: JSON.stringify(payload),
    });
    const json = await this.parseBody(res);
    if (!res.ok) {
      throw new OmronConnectError(`Omron API error on ${path}`, res.status, json);
    }
    return json;
  }

  private async get(path: string): Promise<any> {
    const res = await fetch(this.appUrl() + path, { method: 'GET', headers: this.headers() });
    const json = await this.parseBody(res);
    if (!res.ok) throw new OmronConnectError(`Omron API error on ${path}`, res.status, json);
    return json;
  }

  // ── Auth ───────────────────────────────────────────────────────────────────

  /** Login with the user's Omron Connect account credentials. */
  async login(email: string, password: string): Promise<OmronTokens> {
    const res = await fetch(`${this.region.cloudUrl}/oauth2/token`, {
      method: 'POST',
      headers: { ...this.headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: email, password }),
    });
    const json: any = await this.parseBody(res);
    if (!res.ok || !json.access_token) {
      throw new OmronConnectError(
        'Omron login failed (check email/password/region)',
        res.status,
        json,
      );
    }
    this.accessToken = json.access_token;
    return { accessToken: json.access_token, refreshToken: json.refresh_token };
  }

  /** Exchange a refresh token for a fresh token pair. */
  async refresh(refreshToken: string): Promise<OmronTokens> {
    const res = await fetch(`${this.region.cloudUrl}/oauth2/token`, {
      method: 'POST',
      headers: { ...this.headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: refreshToken }),
    });
    const json: any = await this.parseBody(res);
    if (!res.ok || !json.access_token) {
      throw new OmronConnectError('Omron token refresh failed', res.status, json);
    }
    this.accessToken = json.access_token;
    if (this.onTokensRefreshed) {
      await this.onTokensRefreshed({
        accessToken: json.access_token,
        refreshToken: json.refresh_token,
      });
    }
    return { accessToken: json.access_token, refreshToken: json.refresh_token };
  }

  /** Resume an authenticated session with a stored access token. */
  withAccessToken(accessToken: string): this {
    this.accessToken = accessToken;
    return this;
  }

  // ── Account / devices ──────────────────────────────────────────────────────

  /** Stable provider-side user identity (falls back to "unknown"). */
  async getUser(): Promise<{
    userID?: string;
    loginName?: string;
    email?: string;
    [k: string]: unknown;
  }> {
    return this.get(`/users/me`);
  }

  /** Devices registered to the account, newest-synced first. */
  async getDevices(daysActive = 30): Promise<OmronDevice[]> {
    const lastSyncDate = Date.now() - daysActive * 24 * 3600 * 1000;
    const devices = new Map<string, OmronDevice>();
    let paginationKey = lastSyncDate;

    // Paginate with lastSyncDate as cursor — zero/undefined nextPaginationKey
    // terminates iteration.
    for (let page = 0; page < 20; page++) {
      const resp: any = await this.post(`/versions/current/synchronizeDeviceConfData`, {
        countOnlyFlag: 0,
        lastSyncDate: paginationKey,
      });
      const syncList: any[] = resp?.returnedValue?.syncList ?? [];
      for (const sync of syncList) {
        for (const cat of sync.deviceCategoryList ?? []) {
          const category = cat.deviceCategory;
          for (const model of cat.deviceModelList ?? []) {
            for (const dev of model.deviceSerialIDList ?? []) {
              // userNumberInDevice 0 is the device itself, not a user profile
              if (/^#?0$/.test(String(dev.userNumberInDevice))) continue;
              const key = `${dev.deviceSerialID}:${dev.userNumberInDevice}`;
              if (!devices.has(key)) {
                devices.set(key, {
                  deviceModel: model.deviceModel,
                  deviceSerialID: String(dev.deviceSerialID),
                  userNumberInDevice: Number(dev.userNumberInDevice),
                  category: String(category ?? ''),
                });
              }
            }
          }
        }
      }
      const nextKey = Number(resp?.returnedValue?.nextPaginationKey ?? 0);
      if (!nextKey || nextKey === paginationKey) break;
      paginationKey = nextKey;
    }
    return [...devices.values()];
  }

  /** Raw measurements for one device since `fromMs` (unix ms, 0 = all). */
  async getMeasurements(
    device: OmronDevice,
    fromMs = 0,
    toMs?: number,
  ): Promise<RawDeviceMeasurements[]> {
    const resp: any = await this.post(`/versions/current/measureData`, {
      containCorrectedDataFlag: 1,
      containAllDataTypeFlag: 1,
      deviceCategory: device.category,
      deviceSerialID: device.deviceSerialID,
      userNumberInDevice: device.userNumberInDevice,
      searchDateFrom: fromMs,
      searchDateTo: toMs ?? Date.now(),
    });

    const returned: any = resp?.returnedValue;
    if (!returned || returned.errorCode) return [];
    const models: any[] = Array.isArray(returned) ? returned : (returned.deviceModelList ?? []);
    const out: RawDeviceMeasurements[] = [];
    for (const model of models) {
      for (const dev of model.deviceSerialIDList ?? []) {
        if (String(dev.deviceSerialID) !== device.deviceSerialID) continue;
        out.push(dev as RawDeviceMeasurements);
      }
    }
    return out;
  }

  /** Flatten every device's measureList into samples. */
  async getMeasureSamples(
    device: OmronDevice,
    fromMs = 0,
    toMs?: number,
  ): Promise<RawMeasureSample[]> {
    const perDevice = await this.getMeasurements(device, fromMs, toMs);
    return perDevice.flatMap((d) => d.measureList ?? []);
  }
}
