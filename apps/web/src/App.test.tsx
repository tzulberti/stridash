import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import App from './App';
import { setLang } from './lib/i18n/index';
import { setLocale, setUnit } from './lib/format';

const { apiMock, readToken, saveTokens, clearTokens, storedRefreshToken, setTokenListener } =
  vi.hoisted(() => ({
    apiMock: vi.fn(),
    readToken: vi.fn(),
    saveTokens: vi.fn(),
    clearTokens: vi.fn(),
    storedRefreshToken: vi.fn(),
    setTokenListener: vi.fn(),
  }));

vi.mock('./lib/api', () => ({ api: apiMock, setTokenListener }));
vi.mock('./lib/token-storage', () => ({
  readToken,
  saveTokens,
  clearTokens,
  storedRefreshToken,
}));

const measurement = {
  measuredAt: '2026-11-26T07:00:00.000Z',
  weightKg: 82.5,
  bodyFatPct: 18.2,
  visceralFatLevel: 7,
  skeletalMuscleMassKg: 36.4,
};

const activity = {
  id: 'a1',
  headline: 'Morning Ride',
  type: 'RIDE',
  startTime: '2026-11-26T08:00:00.000Z',
  durationS: 3_600,
  distanceM: 30_000,
  avgSpeedMs: 8.33,
  avgHr: 140,
  avgPowerW: 200,
  providers: ['GARMIN'],
};

const sleepRow = {
  dateKey: '2026-11-26',
  startAt: null,
  endAt: null,
  totalSleepS: 28_800,
  deepS: 7_000,
  lightS: 14_000,
  remS: 7_800,
  awakeS: 0,
  napS: null,
  awakeCount: 1,
  avgSleepStress: 20,
  avgHr: 55,
  avgRespiration: 14,
  restingHr: 50,
  hrvStatus: 'balanced',
  hrvAvg: 60,
  bodyBatteryChange: 40,
  sleepNeedMin: 480,
  sleepScore: 85,
};

const wellnessRow = {
  dateKey: '2026-11-26',
  steps: 10_000,
  stepsGoal: 8_000,
  distanceM: 8_000,
  floorsAsc: 12,
  floorsDesc: 10,
  activeCal: 500,
  restingCal: 1_500,
  totalCal: 2_000,
  hrMin: 45,
  hrMax: 160,
  restingHr: 52,
  moderateMin: 20,
  vigorousMin: 10,
  intensityGoal: 150,
  stressAvg: 30,
  stressMax: 80,
  batteryMin: 20,
  batteryMax: 90,
  batteryLatest: 70,
};

function mockApi() {
  apiMock.mockImplementation(async (path: string, opts?: { query?: Record<string, string> }) => {
    if (path === '/me') return { email: 'alice@example.com', preferences: {} };
    if (path === '/connections') return { items: [] };
    if (path === '/measurements') return { items: [measurement] };
    if (path === '/activities') return { items: [activity], nextCursor: null };
    if (path === '/sleeps') return { items: opts?.query?.to ? [] : [sleepRow] };
    if (path === '/wellness') return { items: opts?.query?.to ? [] : [wellnessRow] };
    if (path === '/auth/login') return { accessToken: 'at', refreshToken: 'rt' };
    return {};
  });
}

beforeEach(() => {
  setLang('en');
  setLocale('en');
  setUnit('km');
  localStorage.clear();
  readToken.mockReset();
  readToken.mockReturnValue(null);
  saveTokens.mockReset();
  clearTokens.mockReset();
  storedRefreshToken.mockReset();
  storedRefreshToken.mockReturnValue(null);
  setTokenListener.mockReset();
  apiMock.mockReset();
  mockApi();
  window.history.replaceState(null, '', '/');
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('App auth flow', () => {
  it('shows the login form and enters the dashboard after signing in', async () => {
    render(<App />);
    expect(screen.getByText('One dashboard for every stride.')).toBeTruthy();

    fireEvent.change(screen.getByPlaceholderText('email'), {
      target: { value: 'alice@example.com' },
    });
    fireEvent.change(screen.getByPlaceholderText('password'), { target: { value: 'secret' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => expect(saveTokens).toHaveBeenCalledWith('at', 'rt', true));
    expect(await screen.findByText('Latest weight')).toBeTruthy();
    expect(apiMock).toHaveBeenCalledWith('/auth/login', {
      method: 'POST',
      body: { email: 'alice@example.com', password: 'secret' },
    });
  });

  it('shows a login failure and stays on the form', async () => {
    apiMock.mockImplementation(async (path: string) => {
      if (path === '/auth/login') throw new Error('bad credentials');
      return {};
    });
    render(<App />);

    fireEvent.change(screen.getByPlaceholderText('email'), {
      target: { value: 'alice@example.com' },
    });
    fireEvent.change(screen.getByPlaceholderText('password'), { target: { value: 'wrong' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByText(/bad credentials/)).toBeTruthy();
    expect(saveTokens).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeTruthy();
  });

  it('boots from a stored token, loads the dashboard and signs out', async () => {
    readToken.mockReturnValue('tok');
    render(<App />);

    expect(await screen.findByText('Latest weight')).toBeTruthy();
    expect(screen.getByText('82.5 kg')).toBeTruthy();
    expect(screen.getByText('10,000')).toBeTruthy();
    expect(apiMock).toHaveBeenCalledWith('/connections', { token: 'tok' });
    expect(apiMock).toHaveBeenCalledWith('/activities', {
      token: 'tok',
      query: { limit: '100' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'menu' }));
    fireEvent.click(screen.getByRole('button', { name: 'Sign Out' }));

    expect(clearTokens).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('One dashboard for every stride.')).toBeTruthy();
  });

  it('clears a dead session when the first load gets a 401', async () => {
    readToken.mockReturnValue('tok');
    apiMock.mockImplementation(async (path: string) => {
      if (path === '/me') return { preferences: {} };
      throw new Error('401 Unauthorized');
    });
    render(<App />);

    await waitFor(() => expect(clearTokens).toHaveBeenCalled());
    expect(await screen.findByText('One dashboard for every stride.')).toBeTruthy();
  });
});
