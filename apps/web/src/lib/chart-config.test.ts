import { describe, expect, it } from 'vitest';
import { orderedChannels, PROVIDER_CHANNELS, SERIES_CHANNELS } from './chart-config';

const keys = (rows: Array<[string, unknown, unknown, unknown]>): string[] =>
  rows.map(([key]) => key);

describe('orderedChannels', () => {
  it('returns the canonical order without a saved configuration', () => {
    expect(orderedChannels('GARMIN', undefined).map(([k]) => k)).toEqual(
      SERIES_CHANNELS.map(([k]) => k),
    );
    expect(orderedChannels(undefined, {})).toBe(SERIES_CHANNELS);
  });

  it('follows the saved order and hides configured-invisible channels', () => {
    const rows = orderedChannels('GARMIN', {
      GARMIN: [
        { key: 'powerW', visible: true },
        { key: 'speedMs', visible: false },
        { key: 'hrBpm', visible: true },
      ],
    });

    expect(keys(rows)).toEqual([
      'powerW',
      'hrBpm',
      // channels absent from the config append in canonical order, still visible
      'cadenceRpm',
      'altitudeM',
      'respirationRate',
      'staminaPct',
      'stepLengthM',
      'verticalOscillationM',
      'stanceTimePct',
      'verticalRatioPct',
      'temperatureC',
    ]);
  });

  it('ignores stale keys and a config for another provider', () => {
    const rows = orderedChannels('ZWIFT', {
      GARMIN: [{ key: 'powerW', visible: false }],
      ZWIFT: [
        { key: 'retiredChannel', visible: true },
        { key: 'altitudeM', visible: true },
        { key: 'speedMs', visible: true },
      ],
    });

    expect(keys(rows).slice(0, 2)).toEqual(['altitudeM', 'speedMs']);
    expect(keys(rows)).toEqual(
      expect.arrayContaining(['speedMs', 'hrBpm', 'powerW', 'cadenceRpm', 'altitudeM']),
    );
  });
});

describe('PROVIDER_CHANNELS', () => {
  it('only lists catalog channels', () => {
    const catalog = new Set(SERIES_CHANNELS.map(([k]) => k));
    for (const channels of Object.values(PROVIDER_CHANNELS)) {
      for (const key of channels ?? []) expect(catalog.has(key)).toBe(true);
    }
  });
});
