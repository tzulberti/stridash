import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DashboardScreen } from './DashboardScreen';

const { loadDashboard, syncConnection } = vi.hoisted(() => ({
  loadDashboard: vi.fn(),
  syncConnection: vi.fn(),
}));
vi.mock('@/lib/api', () => ({
  loadDashboard,
  syncConnection,
  createMeasurement: vi.fn(),
  connectProvider: vi.fn(),
  stravaAuthorizeUrl: vi.fn(),
  verifyConnectionMfa: vi.fn(),
}));
vi.mock('expo-web-browser', () => ({ openBrowserAsync: vi.fn() }));
vi.mock('react-native-safe-area-context', () => ({
  SafeAreaView: ({ children }: { children?: unknown }) => <>{children}</>,
}));

const onSignOut = vi.fn();

const data = {
  me: { email: 'alice@example.com', displayName: 'Alice', createdAt: '2026-01-01' },
  connections: [
    {
      id: 'c1',
      provider: 'GARMIN',
      providerUserId: 'rider',
      status: 'ACTIVE',
      lastSyncedAt: '2026-11-27T08:00:00.000Z',
    },
  ],
  measurements: [{ id: 'm1', weightKg: 82.5, bodyFatPct: 18.4 }],
  activities: [
    {
      id: 'a1',
      headline: 'Morning Ride',
      type: 'RIDE',
      startTime: '2026-11-27T08:00:00.000Z',
      durationS: 3_600,
      distanceM: 30_000,
    },
  ],
  sleeps: [{ dateKey: '2026-11-26', totalSleepS: 28_800, sleepScore: 85, restingHr: 50 }],
  wellness: [{ dateKey: '2026-11-26', steps: 10_000, restingHr: 52, batteryLatest: 70 }],
};

beforeEach(() => {
  loadDashboard.mockReset();
  syncConnection.mockReset();
  onSignOut.mockReset();
  loadDashboard.mockResolvedValue(data);
  syncConnection.mockResolvedValue({ status: 'queued' });
});

afterEach(() => cleanup());

describe('DashboardScreen', () => {
  it('renders the mobile dashboard cards, connections and activities', async () => {
    render(<DashboardScreen token="tok" onSignOut={onSignOut} />);

    expect(await screen.findByText('Alice · alice@example.com')).toBeTruthy();
    expect(screen.getByText('82.5 kg')).toBeTruthy();
    expect(screen.getByText('18.4%')).toBeTruthy();
    expect(screen.getByText('8h 0m')).toBeTruthy();
    expect(screen.getByText('85')).toBeTruthy();
    expect(screen.getByText('10,000')).toBeTruthy();
    expect(screen.getByText('52 bpm')).toBeTruthy();
    expect(screen.getByText('1/1')).toBeTruthy();
    expect(screen.getByText('Morning Ride')).toBeTruthy();
    expect(screen.getByText(/ride ·/)).toBeTruthy();
  });

  it('queues a connection sync and signs out', async () => {
    render(<DashboardScreen token="tok" onSignOut={onSignOut} />);
    await screen.findByText('Alice · alice@example.com');

    fireEvent.click(screen.getByText('Sync'));
    await waitFor(() => expect(syncConnection).toHaveBeenCalledWith('c1', 'tok'));
    expect(await screen.findByText('Garmin sync queued')).toBeTruthy();

    fireEvent.click(screen.getByText('Sign out'));
    expect(onSignOut).toHaveBeenCalledTimes(1);
  });

  it('shows a load error', async () => {
    loadDashboard.mockRejectedValueOnce(new Error('session expired'));
    render(<DashboardScreen token="tok" onSignOut={onSignOut} />);
    expect(await screen.findByText('session expired')).toBeTruthy();
  });
});
