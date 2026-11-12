/**
 * FIT device_info extraction — the recording device only. Verified against
 * live files 2026-11-12:
 *  - Garmin FITs carry 14+ device_infos; the recorder is device_index
 *    "creator" (manufacturer "garmin", product 4024 = Forerunner 955 Solar).
 *  - iGPSPORT FITs carry a single message with no device_index (manufacturer
 *    "igpsport", product 301, hardware_version 110).
 *  - Sensors (gps / accelerometer / sensor_hub) must never be picked.
 */
import { describe, expect, it } from 'vitest';
import { extractFitDevice } from '../src/providers/igpsport/fit.js';

describe('extractFitDevice', () => {
  it('picks the creator message out of a multi-device Garmin file', () => {
    const device = extractFitDevice([
      {
        timestamp: '2026-11-11T10:49:26.000Z',
        serial_number: 3422639741,
        manufacturer: 'garmin',
        product: 4024,
        software_version: 29.05,
        device_index: 'creator',
        source_type: 'local',
      },
      {
        manufacturer: 'garmin',
        product: 3865,
        software_version: 13,
        device_index: 2,
        device_type: 'gps',
      },
      { device_index: 3, device_type: 'accelerometer' },
    ]);
    expect(device).toEqual({
      manufacturer: 'garmin',
      productCode: 4024,
      serialNumber: '3422639741',
      softwareVersion: '29.05',
      hardwareVersion: null,
      raw: expect.objectContaining({ product: 4024 }),
    });
  });

  it('falls back to the lone serial-carrying message (iGPSPORT shape)', () => {
    const device = extractFitDevice([
      {
        timestamp: '2025-07-05T20:39:42.000Z',
        serial_number: 72364288,
        manufacturer: 'igpsport',
        product: 301,
        software_version: 1.31,
        device_type: 0,
        hardware_version: 110,
      },
    ]);
    expect(device).toMatchObject({
      manufacturer: 'igpsport',
      productCode: 301,
      serialNumber: '72364288',
      softwareVersion: '1.31',
      hardwareVersion: '110',
    });
  });

  it('never picks a sensor message even when it is the only one', () => {
    expect(
      extractFitDevice([{ device_index: 2, device_type: 'gps', manufacturer: 'garmin' }]),
    ).toBeNull();
  });

  it('skips sensors and no-serial messages to find the recorder', () => {
    const device = extractFitDevice([
      { device_index: 3, device_type: 'accelerometer' },
      { device_index: 4, device_type: 'sensor_hub', product: 4025 },
      { serial_number: 999, manufacturer: 'garmin', product: 4024, device_index: 5 },
    ]);
    expect(device?.serialNumber).toBe('999');
  });

  it('returns null for missing / malformed payloads', () => {
    expect(extractFitDevice(undefined)).toBeNull();
    expect(extractFitDevice([])).toBeNull();
    expect(extractFitDevice(['nope', 42, null])).toBeNull();
  });
});
