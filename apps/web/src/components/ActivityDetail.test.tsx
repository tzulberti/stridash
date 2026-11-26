import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Activity } from '@stridash/types';
import { ActivityDetail } from './ActivityDetail';
import { setLang } from '../lib/i18n/index';
import { setLocale, setUnit } from '../lib/format';

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }));
vi.mock('../lib/api', () => ({ api: apiMock }));

const activity = {
  id: 'a1',
  headline: 'Morning Ride',
  type: 'RIDE',
  startTime: '2026-11-20T08:00:00.000Z',
  durationS: 3_600,
  movingTimeS: 3_500,
  distanceM: 30_000,
  avgSpeedMs: 8.33,
  maxSpeedMs: 12,
  totalAscentM: 300,
  totalDescentM: 290,
  elevationHighM: 500,
  elevationLowM: 200,
  avgHr: 140,
  maxHr: 175,
  avgPowerW: 200,
  maxPowerW: 400,
  avgCadence: 85,
  maxCadence: 110,
  trainingLoad: 50,
  sweatLossMl: 500,
  aerobicTe: 3,
  anaerobicTe: 1,
  aerobicTeMessage: null,
  anaerobicTeMessage: null,
  vo2max: 50,
  recoveryMinutes: 60,
  normalizedPowerW: 210,
  caloriesKcal: 700,
  indoor: false,
  hrZonesMin: [10, 20, 30, 40, 50],
  notes: null,
  workoutName: null,
  providers: ['GARMIN'],
  device: null,
  raw: {},
  detailRaw: null,
} as unknown as Activity;

const series = [
  {
    provider: 'GARMIN',
    sampleCount: 3,
    series: {
      timeMs: [0, 1_000, 2_000],
      distanceM: [0, 5, 10],
      speedMs: [5, 6, 7],
      hrBpm: [120, 130, 140],
      altitudeM: [100, 101, 102],
      powerW: [180, 200, 220],
      cadenceRpm: [80, 85, 90],
    },
  },
];

function mockDetail(overrides: Record<string, unknown> = {}) {
  apiMock.mockImplementation(async (path: string, opts?: { method?: string }) => {
    if (path === '/activities/a1' && !opts?.method) {
      return { items: [{ ...activity, ...overrides, series }] };
    }
    if (path === '/activities/a1/similar') return { items: [] };
    if (path === '/activities/a1/resync') {
      return { results: [{ provider: 'GARMIN', status: 'ok' }] };
    }
    if (path === '/activities/a2') return { items: [{ ...activity, id: 'a2', series }] };
    return {};
  });
}

const baseProps = {
  id: 'a1',
  token: 'tok',
  preview: null,
  onBack: vi.fn(),
  chartChannels: {},
};

beforeEach(() => {
  setLang('en');
  setLocale('en');
  setUnit('km');
  baseProps.onBack.mockReset();
  apiMock.mockReset();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.history.replaceState(null, '', '/');
});

describe('ActivityDetail', () => {
  it('loads the activity, scalar cards and stream charts', async () => {
    mockDetail();
    render(<ActivityDetail {...baseProps} />);

    expect(await screen.findByText(/Morning Ride/)).toBeTruthy();
    expect(screen.getByText('Distance')).toBeTruthy();
    expect(screen.getByText('30.00 km')).toBeTruthy();
    expect(screen.getByText('1:00:00')).toBeTruthy();
    expect(screen.getAllByRole('img').length).toBeGreaterThan(0);
    expect(await screen.findByText(/No similar activities yet/)).toBeTruthy();
    expect(apiMock).toHaveBeenCalledWith('/activities/a1', { token: 'tok' });
  });

  it('shows not-found and fetch errors', async () => {
    apiMock.mockImplementation(async (path: string) => {
      if (path === '/activities/a1/similar') return { items: [] };
      return { items: [] };
    });
    const { unmount } = render(<ActivityDetail {...baseProps} />);
    expect(await screen.findByText('activity not found')).toBeTruthy();
    unmount();

    apiMock.mockImplementation(async (path: string) => {
      if (path === '/activities/a1/similar') return { items: [] };
      throw new Error('detail down');
    });
    render(<ActivityDetail {...baseProps} />);
    expect(await screen.findByText(/detail down/)).toBeTruthy();
  });

  it('resyncs from the owning provider and refreshes the view', async () => {
    mockDetail();
    render(<ActivityDetail {...baseProps} />);
    await screen.findByText(/Morning Ride/);

    fireEvent.click(screen.getByRole('button', { name: 'Re-sync from provider' }));

    expect(await screen.findByText('Re-synced from GARMIN')).toBeTruthy();
    expect(apiMock).toHaveBeenCalledWith('/activities/a1/resync', {
      method: 'POST',
      token: 'tok',
    });
    // the post-resync refresh re-reads the detail row
    await waitFor(() =>
      expect(
        apiMock.mock.calls.filter(([path, opts]) => path === '/activities/a1' && !opts?.method),
      ).toHaveLength(2),
    );
  });

  it('surfaces a failed resync result', async () => {
    mockDetail();
    apiMock.mockImplementation(async (path: string, opts?: { method?: string }) => {
      if (path === '/activities/a1' && !opts?.method) {
        return { items: [{ ...activity, series }] };
      }
      if (path === '/activities/a1/similar') return { items: [] };
      if (path === '/activities/a1/resync') {
        return { results: [{ provider: 'GARMIN', status: 'failed', error: 'api down' }] };
      }
      return {};
    });
    render(<ActivityDetail {...baseProps} />);
    await screen.findByText(/Morning Ride/);

    fireEvent.click(screen.getByRole('button', { name: 'Re-sync from provider' }));
    expect(await screen.findByText(/Re-sync failed: GARMIN — api down/)).toBeTruthy();
  });

  it('compares against a similar activity', async () => {
    apiMock.mockImplementation(async (path: string, opts?: { method?: string }) => {
      if (path === '/activities/a1' && !opts?.method) {
        return { items: [{ ...activity, series }] };
      }
      if (path === '/activities/a1/similar') {
        return {
          items: [
            {
              id: 'a2',
              headline: 'Other Ride',
              type: 'RIDE',
              startTime: '2026-11-21T08:00:00.000Z',
              durationS: 3_900,
              movingTimeS: 3_800,
              distanceM: 31_000,
              avgSpeedMs: 8.0,
            },
          ],
        };
      }
      if (path === '/activities/a2') {
        return { items: [{ ...activity, id: 'a2', headline: 'Other Ride', series }] };
      }
      return {};
    });
    render(<ActivityDetail {...baseProps} />);
    await screen.findByText(/Morning Ride/);

    await screen.findByRole('option', { name: /Other Ride/ });
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'a2' } });

    expect(await screen.findByRole('heading', { name: 'Compare' })).toBeTruthy();
    expect((await screen.findAllByText(/Other Ride/)).length).toBeGreaterThan(0);
    expect(apiMock).toHaveBeenCalledWith('/activities/a2', { token: 'tok' });
  });

  it('toggles the shared X axis and persists it in the URL', async () => {
    mockDetail();
    render(<ActivityDetail {...baseProps} />);
    await screen.findByText(/Morning Ride/);

    fireEvent.click(screen.getByRole('button', { name: 'distance' }));
    expect(window.location.search).toContain('x=distance');
    expect(screen.getAllByText('distance (km)').length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole('button', { name: 'time' }));
    expect(window.location.search).not.toContain('x=distance');
  });
});
