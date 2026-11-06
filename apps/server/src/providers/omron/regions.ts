/**
 * OmronConnect region registry (API v1 — the "Kii app-server-code" API backed
 * by data-<region>.omronconnect.com).
 *
 * Omron does not run a public developer/OAuth program: the Omron Connect mobile
 * app ships an (appId, appKey) pair per region and authenticates end users with
 * their Omron account email + password at `{cloudUrl}/oauth2/token`.
 *
 * Bootstrap URL: https://api.omronconnect.eu/apps/{appId}/server-code
 *
 * Values below mirror the yaml of the Omron Connect mobile apps as gathered by
 * protocol reverse-engineering efforts (see docs/omron.md). Protocol knowledge
 * only — no code copied from omramin (GPLv2).
 */

export interface OmronRegion {
  /** REST base URL, no trailing slash. */
  cloudUrl: string;
  appId: string;
  appKey: string;
  /** Countries served by this endpoint (ISO 3166-1 alpha-2, uppercase). */
  countries: readonly string[];
}

export const OMRON_REGIONS: readonly OmronRegion[] = [
  {
    countries: ["AU", "BD", "ID", "MM", "MY", "NZ", "PH", "SG", "TH", "VN"],
    cloudUrl: "https://data-sg.omronconnect.com/api",
    appId: "lou30y2xfa9f",
    appKey: "392a4bdff8af4141944d30ca8e3cc860",
  },
  {
    countries: ["HK", "JP", "KR", "TW"],
    cloudUrl: "https://data-jp.omronconnect.com/api",
    appId: "1e3ddd17",
    appKey: "b576cf704409ec86facdacc16fbaadad",
  },
  {
    countries: ["IN"],
    cloudUrl: "https://data-in.omronconnect.com/api",
    appId: "cuoy728n",
    appKey: "784uhaescyzyc28l2yh8xsth1xpga21g",
  },
  {
    countries: [
      "AR", "BO", "BR", "CL", "CO", "CR", "DO", "EC", "GT", "HN",
      "MX", "NI", "PA", "PE", "PY", "SV", "UY", "VE",
    ],
    cloudUrl: "https://data-eu.omronconnect.com/api",
    appId: "bfyy2kf1d5a0",
    appKey: "989c6dbdc0244886ac2ba4de4892080e",
  },
  // NOTE: the North America (US/CA, MedView+) and EMEA sets live on the newer
  // OCM "ohiomron" serving stack (API v2), which reports lossy scale data
  // (no impedance / fat-free mass / segmental values). Unsupported until v2
  // coverage is worth the fidelity loss — see docs/omron.md.
];

export function regionForCountry(country: string): OmronRegion | null {
  const c = country.trim().toUpperCase();
  return OMRON_REGIONS.find((r) => r.countries.includes(c)) ?? null;
}
