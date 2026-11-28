import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Activity } from '@stridash/types';
import { AdvancedSearchSection } from './AdvancedSearchSection';
import { setLang } from '../lib/i18n/index';
import { setLocale, setUnit } from '../lib/format';

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }));
vi.mock('../lib/api', () => ({ api: apiMock }));

const ride: Activity = {
  id: 'a1',
  userId: 'u1',
  headline: 'Morning Ride',
  workoutName: 'Sweet spot',
  type: 'RIDE',
  startTime: '2026-11-26T08:00:00.000Z',
  durationS: 3_600,
  movingTimeS: null,
  distanceM: 30_000,
  totalAscentM: null,
  totalDescentM: null,
  elevationHighM: null,
  elevationLowM: null,
  avgSpeedMs: 8.33,
  maxSpeedMs: null,
  avgHr: 140,
  maxHr: null,
  avgPowerW: 200,
  maxPowerW: null,
  avgCadence: null,
  maxCadence: null,
  caloriesKcal: null,
  trainingLoad: null,
  sweatLossMl: null,
  aerobicTe: null,
  anaerobicTe: null,
  aerobicTeMessage: null,
  anaerobicTeMessage: null,
  vo2max: null,
  recoveryMinutes: null,
  normalizedPowerW: null,
  providers: ['GARMIN'],
  indoor: false,
  gearId: 'g1',
  createdAt: '2026-11-26T09:00:00.000Z',
};

const run: Activity = {
  ...ride,
  id: 'a2',
  headline: 'Lunch Run',
  workoutName: 'Easy run',
  type: 'RUN',
  distanceM: 8_000,
  gearId: null,
};

const baseProps = {
  token: 'tok',
  gear: [{ id: 'g1', name: 'Road bike' }],
  openActivity: vi.fn(),
  onBack: vi.fn(),
};

beforeEach(() => {
  setLang('en');
  setLocale('en');
  setUnit('km');
  apiMock.mockReset();
  apiMock.mockResolvedValue({ items: [ride], nextCursor: null });
  window.history.replaceState(null, '', '/search');
});

afterEach(() => cleanup());

describe('AdvancedSearchSection', () => {
  it('renders the query-builder filters and runs an initial search', async () => {
    render(<AdvancedSearchSection {...baseProps} />);

    expect(screen.getByText('Date range')).toBeTruthy();
    expect(screen.getByRole('button', { name: /run/i })).toBeTruthy();
    expect(screen.getByLabelText('Gear')).toBeTruthy();
    expect(screen.getByLabelText('min distance')).toBeTruthy();

    expect(await screen.findByText('1 activities')).toBeTruthy();
    expect(apiMock).toHaveBeenCalledWith('/activities', {
      token: 'tok',
      query: { limit: '100' },
    });
    expect(screen.getByText('Sweet spot')).toBeTruthy();

    fireEvent.click(screen.getByRole('link', { name: 'details' }));
    expect(baseProps.openActivity).toHaveBeenCalledWith('a1');
  });

  it('hydrates every filter from a deep link', async () => {
    window.history.replaceState(
      null,
      '',
      '/search?from=2026-11-01&to=2026-11-30&types=RUN,RIDE&gearId=g1&dminM=5000&dmaxM=10000&show=date,types,gear,distance',
    );
    render(<AdvancedSearchSection {...baseProps} />);

    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith('/activities', {
        token: 'tok',
        query: {
          limit: '100',
          from: '2026-11-01T00:00:00.000Z',
          to: '2026-11-30T23:59:59.999Z',
          types: 'RUN,RIDE',
          gearId: 'g1',
          distanceMinM: '5000',
          distanceMaxM: '10000',
        },
      }),
    );
    expect(screen.getByLabelText('min distance')).toHaveProperty('value', '5');
  });

  it('removes and re-adds a filter', async () => {
    render(<AdvancedSearchSection {...baseProps} />);
    await screen.findByText('1 activities');

    fireEvent.click(screen.getByRole('button', { name: 'Remove filter distance' }));
    expect(screen.queryByLabelText('min distance')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Remove filter Date range' }));
    expect(screen.queryByText('from date')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Remove filter type' }));
    expect(screen.queryByRole('button', { name: /run/i })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Remove filter Gear' }));
    expect(screen.queryByLabelText('Gear')).toBeNull();

    fireEvent.change(screen.getByRole('combobox', { name: 'Add filter' }), {
      target: { value: 'distance' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add filter' }));
    expect(screen.getByLabelText('min distance')).toBeTruthy();
  });

  it('toggles types, clears all values and re-runs the query', async () => {
    render(<AdvancedSearchSection {...baseProps} />);
    await screen.findByText('1 activities');

    fireEvent.click(screen.getByRole('button', { name: /run/i }));
    fireEvent.click(screen.getByRole('button', { name: /run/i })); // selected → deselected
    fireEvent.change(screen.getByLabelText('min distance'), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() =>
      expect(apiMock).toHaveBeenLastCalledWith('/activities', {
        token: 'tok',
        query: { limit: '100', distanceMinM: '2000' },
      }),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    await waitFor(() =>
      expect(apiMock).toHaveBeenLastCalledWith('/activities', {
        token: 'tok',
        query: { limit: '100' },
      }),
    );
    expect(screen.getByLabelText('min distance')).toHaveProperty('value', '');
  });

  it('shows empty and error states', async () => {
    apiMock.mockResolvedValueOnce({ items: [], nextCursor: null });
    const { unmount } = render(<AdvancedSearchSection {...baseProps} />);
    expect(await screen.findByText('No activities match this query.')).toBeTruthy();
    unmount();

    apiMock.mockRejectedValueOnce(new Error('search down'));
    render(<AdvancedSearchSection {...baseProps} />);
    expect(await screen.findByText('search down')).toBeTruthy();
  });

  it('combines date, type, gear and distance filters into one query', async () => {
    render(<AdvancedSearchSection {...baseProps} />);
    await screen.findByText('1 activities');

    fireEvent.click(screen.getByRole('button', { name: /run/i }));
    fireEvent.change(screen.getByLabelText('Gear'), { target: { value: 'g1' } });
    fireEvent.change(screen.getByLabelText('min distance'), { target: { value: '5' } });
    fireEvent.change(screen.getByLabelText('max distance'), { target: { value: '10' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));

    await waitFor(() =>
      expect(apiMock).toHaveBeenLastCalledWith('/activities', {
        token: 'tok',
        query: {
          limit: '100',
          types: 'RUN',
          gearId: 'g1',
          distanceMinM: '5000',
          distanceMaxM: '10000',
        },
      }),
    );
  });

  it('blocks an inverted distance range', async () => {
    render(<AdvancedSearchSection {...baseProps} />);
    await screen.findByText('1 activities');

    fireEvent.change(screen.getByLabelText('min distance'), { target: { value: '10' } });
    fireEvent.change(screen.getByLabelText('max distance'), { target: { value: '5' } });

    expect(screen.getByText(/Minimum distance cannot be greater/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Search' }).hasAttribute('disabled')).toBe(true);
    expect(apiMock).toHaveBeenCalledTimes(1);
  });

  it('appends the next page with the cursor from the applied query', async () => {
    apiMock.mockImplementation(async (_path: string, opts?: { query?: Record<string, string> }) =>
      opts?.query?.cursor
        ? { items: [run], nextCursor: null }
        : { items: [ride], nextCursor: 'cursor-1' },
    );
    render(<AdvancedSearchSection {...baseProps} />);

    expect(await screen.findByText('1+ activities')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));

    await waitFor(() =>
      expect(apiMock).toHaveBeenLastCalledWith('/activities', {
        token: 'tok',
        query: { limit: '100', cursor: 'cursor-1' },
      }),
    );
    expect(await screen.findByText('2 activities')).toBeTruthy();
    expect(screen.getByText('Easy run')).toBeTruthy();
  });
});
