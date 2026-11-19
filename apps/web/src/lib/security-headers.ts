/**
 * Security headers for the production web build.
 *
 * The Vite build emits these as `dist/_headers` (Netlify / Cloudflare Pages
 * format) and `docs/deployment.md` shows the equivalent nginx/Caddy setup.
 * Keep `connect-src` at `'self'`: the dashboard always calls the API on the
 * same origin (Vite dev proxies `/api`; production sidecars it next to the
 * static build). A separately-hosted API needs an explicit origin here.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  // React writes inline style attributes (chart colours); no inline scripts.
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self'",
  "connect-src 'self'",
].join('; ');

export const SECURITY_HEADERS = {
  'Content-Security-Policy': CONTENT_SECURITY_POLICY,
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
} as const;

/** `_headers` file understood by Netlify and Cloudflare Pages. */
export function renderHeadersFile(): string {
  const headers = Object.entries(SECURITY_HEADERS)
    .map(([name, value]) => `  ${name}: ${value}`)
    .join('\n');
  return `/*\n${headers}\n`;
}
