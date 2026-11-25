import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  downloadFit,
  getActivityDetail,
  getProfile,
  listActivities,
  listDevices,
  listGear,
  listGearActivities,
  verifyToken,
} from '../src/providers/garmin/api.js';
import { GarminError } from '../src/providers/garmin/sso.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubStatus(status: number): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      status === 204 ? new Response(null, { status }) : new Response('{}', { status }),
    ),
  );
}

function stubJson(body: unknown, status = 200): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
    ),
  );
}

describe('verifyToken', () => {
  it.each([200, 201, 204])('accepts a %i response', async (status) => {
    stubStatus(status);
    await expect(verifyToken('token')).resolves.toBe(true);
  });

  it.each([301, 400, 401, 403, 429, 500, 503])('rejects a %i response', async (status) => {
    stubStatus(status);
    await expect(verifyToken('token')).resolves.toBe(false);
  });
});

describe('Garmin API payloads', () => {
  it('returns {} for a non-object profile and degrades malformed lists to []', async () => {
    stubJson(null);
    await expect(getProfile('token')).resolves.toEqual({});
    await expect(listActivities('token', 0, 20)).resolves.toEqual([]);
    await expect(listGear('token')).resolves.toEqual([]);
    await expect(listDevices('token')).resolves.toEqual([]);

    stubJson('<not json>', 200);
    await expect(getProfile('token')).resolves.toEqual({});
    await expect(listActivities('token', 0, 20)).resolves.toEqual([]);
  });

  it('filters gear-activity and device rows to usable entries', async () => {
    stubJson([{ activityId: 1 }, { activityId: '2' }, { activityId: undefined }, null]);
    await expect(listGearActivities('token', 'gear-1')).resolves.toEqual([
      { activityId: 1 },
      { activityId: '2' },
    ]);

    stubJson([
      {
        deviceId: 42,
        productDisplayName: 'Forerunner 955 Solar',
        deviceTypePk: 9001,
        partNumber: '010-1',
      },
      { productDisplayName: 'No id' },
      null,
    ]);
    await expect(listDevices('token')).resolves.toEqual([
      {
        deviceId: 42,
        productDisplayName: 'Forerunner 955 Solar',
        deviceTypePk: 9001,
        partNumber: '010-1',
      },
    ]);
  });

  it('synthesizes the row + device from an activity detail', async () => {
    stubJson({
      activityId: 123,
      activityName: 'Morning Run',
      summaryDTO: {
        startTimeGMT: '2026-11-11 06:30:00',
        distance: 10_000,
        duration: 3_600,
        trainingEffect: 3.2,
        normalizedPower: 240,
        vO2MaxValue: 51,
      },
      activityTypeDTO: { typeKey: 'running' },
      metadataDTO: {
        lastUpdateDate: '2026-11-11T11:13:12.0',
        manufacturer: 'GARMIN',
        deviceMetaDataDTO: { deviceId: 42, deviceTypePk: 9001 },
      },
    });

    await expect(getActivityDetail('token', '123')).resolves.toMatchObject({
      lastUpdateDate: '2026-11-11T11:13:12.0',
      device: { deviceId: '42', deviceTypePk: 9001, manufacturer: 'GARMIN' },
      row: {
        activityId: 123,
        activityName: 'Morning Run',
        startTimeGMT: '2026-11-11 06:30:00',
        distance: 10_000,
        duration: 3_600,
        aerobicTrainingEffect: 3.2,
        normPower: 240,
        vO2MaxValue: 51,
        activityType: { typeKey: 'running' },
      },
    });
  });

  it('returns null for non-200 or non-object activity details', async () => {
    stubStatus(404);
    await expect(getActivityDetail('token', '123')).resolves.toBeNull();

    stubJson(null);
    await expect(getActivityDetail('token', '123')).resolves.toBeNull();
  });

  it('downloads the FIT payload and reports a non-2xx response', async () => {
    const fit = Buffer.from('fit-bytes');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(fit, { status: 200 })),
    );
    await expect(downloadFit('token', '123')).resolves.toEqual(fit);

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('missing', { status: 404 })),
    );
    const err = await downloadFit('token', '123').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GarminError);
    expect(err).toMatchObject({
      kind: 'CONNECTION',
      message: 'FIT download for 123 returned HTTP 404',
    });
  });
});
