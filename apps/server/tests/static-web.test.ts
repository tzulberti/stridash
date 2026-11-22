/**
 * The production image serves the Vite dashboard from the same process as the
 * API. These tests use a temporary dist directory so they do not depend on a
 * prior web build.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

vi.mock('../src/db.js', () => ({ prisma: {} }));

import { createApp } from '../src/index.js';
import type { Env } from '../src/env.js';

const env = {
  DATABASE_URL: 'postgresql://placeholder:placeholder@localhost:5432/placeholder',
  STRIDASH_JWT_SECRET: 'x'.repeat(32),
  STRIDASH_ENC_KEY: 'y'.repeat(32),
  PORT: 3000,
  STRIDASH_VERSION: 'test',
  STRIDASH_AUTH_RATE_LIMIT: 100,
  STRIDASH_AUTH_RATE_WINDOW_MS: 60_000,
  STRIDASH_REGISTER_RATE_LIMIT: 100,
  STRIDASH_LOGIN_RATE_LIMIT: 100,
  STRIDASH_CONNECTION_RATE_LIMIT: 100,
  STRIDASH_CONNECTION_RATE_WINDOW_MS: 60_000,
  STRIDASH_TRUST_PROXY: false,
} as Env;

let webDist = '';
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  webDist = await mkdtemp(path.join(tmpdir(), 'stridash-web-'));
  await mkdir(path.join(webDist, 'assets'), { recursive: true });
  await writeFile(
    path.join(webDist, 'index.html'),
    '<!doctype html><html><body><div id="root"></div></body></html>',
  );
  await writeFile(path.join(webDist, 'assets', 'app-abc123.js'), 'console.log("dashboard");');
  app = createApp({ ...env, STRIDASH_WEB_DIST: webDist });
});

afterAll(async () => {
  await rm(webDist, { recursive: true, force: true });
});

describe('static web dashboard', () => {
  it('serves index.html with security headers and no-cache', async () => {
    const res = await app.request('/');

    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<div id="root">');
    expect(res.headers.get('content-security-policy')).toContain("default-src 'self'");
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('cache-control')).toBe('no-cache');
  });

  it('serves fingerprinted assets with immutable caching', async () => {
    const res = await app.request('/assets/app-abc123.js');

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('console.log("dashboard");');
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
  });

  it('falls back to index.html for client-side routes', async () => {
    const res = await app.request('/activities/123');

    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<div id="root">');
  });

  it('404s a missing asset instead of returning the SPA', async () => {
    const res = await app.request('/assets/missing.js');

    expect(res.status).toBe(404);
    expect(res.headers.get('cache-control')).toBe('no-cache');
    expect(await res.text()).not.toContain('<div id="root">');
  });

  it('keeps /api/* on the API path instead of returning the SPA', async () => {
    const health = await app.request('/api/health');
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ status: 'ok' });

    const missing = await app.request('/api/does-not-exist');
    expect(missing.status).toBeGreaterThanOrEqual(400);
    expect(await missing.text()).not.toContain('<div id="root">');
  });
});
