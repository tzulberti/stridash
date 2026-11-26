import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { GearSection } from './GearSection';
import { setLang } from '../lib/i18n/index';
import { setUnit } from '../lib/format';

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }));
vi.mock('../lib/api', () => ({ api: apiMock }));

const gear = [
  {
    id: 'g1',
    name: 'Bike',
    kind: 'BIKE',
    provider: 'GARMIN',
    sourceGearId: 'src-1',
    firstUsedAt: '2026-01-01T00:00:00.000Z',
    retiredAt: null,
    usageType: 'CYCLING',
    thresholdM: 500_000,
    usage: { distanceM: 100_000, durationS: 18_000, count: 2 },
    components: [
      {
        id: 'c1',
        name: 'Chain',
        kind: 'CHAIN',
        installedAt: '2026-01-01T00:00:00.000Z',
        retiredAt: null,
        thresholdM: 300_000,
        notes: null,
        usage: { distanceM: 50_000, durationS: 9_000, count: 1 },
      },
      {
        id: 'c2',
        name: 'Race shoes',
        kind: 'SHOES',
        installedAt: null,
        retiredAt: '2026-06-01T00:00:00.000Z',
        thresholdM: null,
        notes: null,
        usage: { distanceM: 20_000, durationS: 3_600, count: 1 },
      },
    ],
  },
];

const baseProps = { token: 'tok', onBack: vi.fn() };

beforeEach(() => {
  setLang('en');
  setUnit('km');
  baseProps.onBack.mockReset();
  apiMock.mockReset();
  apiMock.mockImplementation(async (path: string, opts?: { method?: string }) => {
    if (path === '/gear' && !opts?.method) return { items: gear };
    return {};
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('GearSection', () => {
  it('loads and renders gear usage, components and thresholds', async () => {
    render(<GearSection {...baseProps} />);
    expect(screen.getByText('Loading…')).toBeTruthy();

    expect(await screen.findByText('Bike')).toBeTruthy();
    expect(screen.getByText('bike')).toBeTruthy();
    expect(screen.getByText('garmin')).toBeTruthy();
    expect(screen.getByText(/100 km · 5\.0 h/)).toBeTruthy();
    expect(screen.getByText(/limit 500 km/)).toBeTruthy();
    expect(screen.getByText(/first used 2026-01-01/)).toBeTruthy();
    expect(screen.getByText(/Chain/)).toBeTruthy();
    expect(screen.getByText(/50 km · 2\.5 h/)).toBeTruthy();
    expect(screen.getByText(/300 km/)).toBeTruthy();
    // provider-specific kinds fall back to readable lowercase text
    expect(screen.getByText('(shoes)')).toBeTruthy();
    expect(screen.getByText(/retired 2026-06-01/)).toBeTruthy();
  });

  it('shows the empty state and surfaces load errors', async () => {
    apiMock.mockResolvedValueOnce({ items: [] });
    const { rerender } = render(<GearSection {...baseProps} />);
    expect(await screen.findByText(/no gear synced yet/)).toBeTruthy();

    apiMock.mockRejectedValueOnce(new Error('gear down'));
    rerender(<GearSection {...baseProps} token="tok2" />);
    expect(await screen.findByText('gear down')).toBeTruthy();
  });

  it('adds a component with the selected kind and install date', async () => {
    render(<GearSection {...baseProps} />);
    await screen.findByText('Bike');

    fireEvent.click(screen.getByRole('button', { name: '+ add component' }));
    fireEvent.change(screen.getByPlaceholderText('component name'), {
      target: { value: '  New chain  ' },
    });
    fireEvent.change(screen.getAllByRole('combobox')[0]!, { target: { value: 'CASSETTE' } });
    fireEvent.change(screen.getByTitle('install date — usage counts from here'), {
      target: { value: '2026-02-01' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'add' }));

    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith('/gear/g1/components', {
        method: 'POST',
        token: 'tok',
        body: { name: 'New chain', kind: 'CASSETTE', installedAt: '2026-02-01' },
      }),
    );
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '+ add component' })).toBeTruthy(),
    );
    // GET /gear runs again after the mutation
    expect(apiMock.mock.calls.filter(([path]) => path === '/gear')).toHaveLength(2);
  });

  it('omits the install date when empty and ignores blank names', async () => {
    render(<GearSection {...baseProps} />);
    await screen.findByText('Bike');
    fireEvent.click(screen.getByRole('button', { name: '+ add component' }));
    fireEvent.click(screen.getByRole('button', { name: 'add' }));
    expect(apiMock).not.toHaveBeenCalledWith(
      expect.stringContaining('/components'),
      expect.anything(),
    );

    fireEvent.change(screen.getByPlaceholderText('component name'), {
      target: { value: 'Bottle cage' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'add' }));
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith('/gear/g1/components', {
        method: 'POST',
        token: 'tok',
        body: { name: 'Bottle cage', kind: 'CHAIN' },
      }),
    );
  });

  it('retires and deletes components with a reload after each', async () => {
    render(<GearSection {...baseProps} />);
    await screen.findByText('Bike');

    fireEvent.click(screen.getByRole('button', { name: 'retire' }));
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith('/gear/components/c1', {
        method: 'PATCH',
        token: 'tok',
        body: { retiredAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) },
      }),
    );

    fireEvent.click(screen.getAllByRole('button', { name: '✕' })[0]!);
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith('/gear/components/c1', {
        method: 'DELETE',
        token: 'tok',
      }),
    );
    expect(apiMock.mock.calls.filter(([path]) => path === '/gear').length).toBeGreaterThanOrEqual(
      3,
    );
  });
});
