import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createStravaSubscription,
  deleteStravaSubscription,
  listStravaSubscriptions,
  stravaWebhookConfig,
} from '../src/services/strava-webhooks.js';
import type { Env } from '../src/env.js';

const env = {
  STRIDASH_STRAVA_CLIENT_ID: 'client-1',
  STRIDASH_STRAVA_CLIENT_SECRET: 'secret-1',
  STRIDASH_STRAVA_WEBHOOK_URL: 'https://stridash.example/api/strava/webhook',
  STRIDASH_STRAVA_WEBHOOK_VERIFY_TOKEN: 'hook-token',
} as unknown as Env;

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status });

describe('Strava webhook config', () => {
  it('requires app credentials, callback URL and verify token', () => {
    expect(stravaWebhookConfig(env)).toEqual({
      clientId: 'client-1',
      clientSecret: 'secret-1',
      callbackUrl: 'https://stridash.example/api/strava/webhook',
      verifyToken: 'hook-token',
    });
    expect(() =>
      stravaWebhookConfig({ ...env, STRIDASH_STRAVA_WEBHOOK_URL: undefined } as Env),
    ).toThrow('STRIDASH_STRAVA_WEBHOOK_URL');
    expect(() =>
      stravaWebhookConfig({ ...env, STRIDASH_STRAVA_WEBHOOK_VERIFY_TOKEN: undefined } as Env),
    ).toThrow('STRIDASH_STRAVA_WEBHOOK_VERIFY_TOKEN');
  });
});

describe('Strava webhook subscription API', () => {
  it('lists subscriptions with client credentials', async () => {
    fetchMock.mockResolvedValueOnce(json([{ id: 1, callback_url: 'https://x' }]));
    await expect(listStravaSubscriptions(stravaWebhookConfig(env))).resolves.toEqual([
      { id: 1, callback_url: 'https://x' },
    ]);
    const url = String(fetchMock.mock.calls[0]![0]);
    expect(url).toContain('/api/v3/push_subscriptions?');
    expect(url).toContain('client_id=client-1');
    expect(url).toContain('client_secret=secret-1');
  });

  it('creates and deletes a subscription', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ id: 7, callback_url: 'https://x' }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    await expect(createStravaSubscription(stravaWebhookConfig(env))).resolves.toMatchObject({
      id: 7,
    });
    const body = new URLSearchParams(String(fetchMock.mock.calls[0]![1].body));
    expect(body.get('callback_url')).toBe('https://stridash.example/api/strava/webhook');
    expect(body.get('verify_token')).toBe('hook-token');

    await deleteStravaSubscription(stravaWebhookConfig(env), 7);
    const url = String(fetchMock.mock.calls[1]![0]);
    expect(url).toContain('/push_subscriptions/7?');
    expect(fetchMock.mock.calls[1]![1].method).toBe('DELETE');
  });

  it('surfaces the provider error message', async () => {
    fetchMock.mockResolvedValueOnce(json({ message: 'already exists' }, 409));
    await expect(listStravaSubscriptions(stravaWebhookConfig(env))).rejects.toThrow(
      'already exists',
    );
  });
});
