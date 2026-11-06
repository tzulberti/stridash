/**
 * iGPSPORT region profiles (private web-API, reverse-engineered: see
 * docs/igpsport.md; observed from the official web client, protocol facts
 * only — no code from reference projects).
 *
 * Two deployments share an auth server but hold separate user databases:
 *  - `intl`: prod.en.igpsport.com — pure JWT auth, no request signing.
 *  - `cn`:   prod.zh.igpsport.com — every request needs an x-signature
 *    produced by a Rust→WASM module (edge_core) shipped in the web frontend.
 *    Node-side execution is feasible but out of scope until needed — CN
 *    accounts are rejected with a clear error for now.
 */

export interface IgpSportRegion {
  key: "intl" | "cn";
  apiBase: string;
  origin: string;
  referer: string;
  appVersion: string;
  timezone: string;
  /** CN only: signed-request key ids. */
  accessKey: string;
  platform: string;
  loginAppId: string;
  signing: boolean;
}

export const IGPSPORT_REGIONS: Record<IgpSportRegion["key"], IgpSportRegion> = {
  intl: {
    key: "intl",
    apiBase: "https://prod.en.igpsport.com",
    origin: "https://app.igpsport.com",
    referer: "https://app.igpsport.com/",
    appVersion: "8.07.06",
    timezone: "Asia/Shanghai",
    accessKey: "",
    platform: "",
    loginAppId: "igpsport-web",
    signing: false,
  },
  cn: {
    key: "cn",
    apiBase: "https://prod.zh.igpsport.com",
    origin: "https://app.igpsport.cn",
    referer: "https://app.igpsport.cn/",
    appVersion: "8.07.08",
    timezone: "Asia/Shanghai",
    accessKey: "AKIDWebClient",
    platform: "web",
    loginAppId: "igpsport-web",
    signing: true,
  },
};

export function regionForKey(key: string): IgpSportRegion | null {
  const r = IGPSPORT_REGIONS[key as IgpSportRegion["key"]];
  return r ?? null;
}
