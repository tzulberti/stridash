import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { Activity, Measurement } from '@stridash/types';
import { DashboardView, type DailyWellnessRow, type SleepRow } from './DashboardView';
import { setLang } from '../lib/i18n/index';
import { setLocale, setUnit } from '../lib/format';

const latest = {
  measuredAt: '2026-11-26T07:00:00.000Z',
  weightKg: 82.5,
  bodyFatPct: 18.2,
  visceralFatLevel: 7,
  skeletalMuscleMassKg: 36.4,
} as Measurement;

const sleep: SleepRow = {
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

const wellness: DailyWellnessRow = {
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

const activities = [
  {
    id: 'a1',
    headline: 'Morning Ride',
    type: 'RIDE',
    startTime: '2026-11-26T08:00:00.000Z',
    durationS: 3_600,
    distanceM: 30_000,
    avgSpeedMs: 8.33,
    avgHr: 140,
    avgPowerW: 200,
    workoutName: 'Sweet spot',
    providers: ['GARMIN'],
  },
] as unknown as Activity[];

const baseProps = {
  header: <header>Dashboard header</header>,
  error: null as string | null,
  activePreset: 7 as number | null | undefined,
  applyPreset: vi.fn(),
  fromDate: '',
  setFromDate: vi.fn(),
  toDate: '',
  setToDate: vi.fn(),
  latest,
  lastSleep: sleep,
  latestWellness: wellness,
  latestRestingHr: wellness,
  activitiesIn: activities,
  measurementsIn: [latest],
  bodyMetric: 'weightKg' as const,
  setBodyMetric: vi.fn(),
  sleepMetric: 'hours' as const,
  setSleepMetric: vi.fn(),
  dailyMetric: 'steps' as const,
  setDailyMetric: vi.fn(),
  weighInsIn: [latest],
  sleepIn: [sleep],
  wellnessIn: [wellness],
  feedType: '',
  setFeedType: vi.fn(),
  feedProv: '',
  setFeedProv: vi.fn(),
  feedTypeOptions: ['RIDE'],
  feedProvOptions: ['GARMIN'],
  activitiesFeed: activities,
  openActivity: vi.fn(),
  loading: false,
};

function renderDashboard(over: Partial<typeof baseProps> = {}) {
  return render(<DashboardView {...baseProps} {...over} />);
}

beforeEach(() => {
  setLang('en');
  setLocale('en');
  setUnit('km');
  for (const fn of [
    baseProps.applyPreset,
    baseProps.setFromDate,
    baseProps.setToDate,
    baseProps.setBodyMetric,
    baseProps.setSleepMetric,
    baseProps.setDailyMetric,
    baseProps.setFeedType,
    baseProps.setFeedProv,
    baseProps.openActivity,
  ]) {
    fn.mockReset();
  }
});

afterEach(() => cleanup());

describe('DashboardView', () => {
  it('renders the stat cards, chart sections and activity feed', () => {
    renderDashboard();

    expect(screen.getByText('Dashboard header')).toBeTruthy();
    expect(screen.getByText('Latest weight')).toBeTruthy();
    expect(screen.getByText('82.5 kg')).toBeTruthy();
    expect(screen.getByText(/8\.0 h · score 85/)).toBeTruthy();
    expect(screen.getByText('10,000')).toBeTruthy();
    expect(screen.getByText('52 bpm')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Body composition' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Sleep' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Daily metrics' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Activities' })).toBeTruthy();
    expect(screen.getByText('30.00 km')).toBeTruthy();
    expect(screen.getByText('Sweet spot')).toBeTruthy();
    expect(screen.getAllByText('garmin').length).toBeGreaterThan(0);
  });

  it('opens an activity from the feed and applies range presets', () => {
    renderDashboard();

    fireEvent.click(screen.getByRole('link', { name: 'details' }));
    expect(baseProps.openActivity).toHaveBeenCalledWith('a1');

    fireEvent.click(screen.getByRole('button', { name: '7d' }));
    expect(baseProps.applyPreset).toHaveBeenCalledWith(7);
    fireEvent.click(screen.getByRole('button', { name: '1y' }));
    expect(baseProps.applyPreset).toHaveBeenCalledWith(365);
    fireEvent.click(screen.getByRole('button', { name: 'all' }));
    expect(baseProps.applyPreset).toHaveBeenCalledWith(null);
  });

  it('shows the custom-range clear button and feed filter empty states', () => {
    const { rerender } = renderDashboard({ fromDate: '2026-11-01', toDate: '2026-11-26' });
    fireEvent.click(screen.getByRole('button', { name: 'clear' }));
    expect(baseProps.applyPreset).toHaveBeenCalledWith(null);

    rerender(
      <DashboardView
        {...baseProps}
        fromDate=""
        toDate=""
        activitiesFeed={[]}
        activitiesIn={activities}
      />,
    );
    expect(screen.getByText('No activities match these filters.')).toBeTruthy();

    rerender(<DashboardView {...baseProps} activitiesFeed={[]} activitiesIn={[]} />);
    expect(screen.getByText('No activities in range.')).toBeTruthy();
  });

  it('changes metric tabs and feed filters', () => {
    renderDashboard();

    fireEvent.click(screen.getByRole('button', { name: 'Body fat' }));
    expect(baseProps.setBodyMetric).toHaveBeenCalledWith('bodyFatPct');
    fireEvent.click(screen.getByRole('button', { name: 'Score' }));
    expect(baseProps.setSleepMetric).toHaveBeenCalledWith('score');
    fireEvent.click(screen.getByRole('button', { name: 'Stress (avg)' }));
    expect(baseProps.setDailyMetric).toHaveBeenCalledWith('stressAvg');

    fireEvent.change(screen.getByLabelText('filter activities by type'), {
      target: { value: 'RIDE' },
    });
    expect(baseProps.setFeedType).toHaveBeenCalledWith('RIDE');
    fireEvent.change(screen.getByLabelText('filter activities by provider'), {
      target: { value: 'GARMIN' },
    });
    expect(baseProps.setFeedProv).toHaveBeenCalledWith('GARMIN');
  });

  it('shows errors and the loading state', () => {
    renderDashboard({ error: 'refresh failed', loading: true });
    expect(screen.getByText('refresh failed')).toBeTruthy();
    expect(screen.getByText('Loading…')).toBeTruthy();
  });

  it('renders empty cards without weigh-ins, sleep or steps', () => {
    renderDashboard({
      latest: undefined,
      lastSleep: undefined,
      latestWellness: undefined,
      latestRestingHr: undefined,
      activitiesIn: [],
      measurementsIn: [],
      weighInsIn: [],
      sleepIn: [],
      wellnessIn: [],
      activitiesFeed: [],
      feedTypeOptions: [],
      feedProvOptions: [],
    });

    expect(screen.getByText('no weigh-in yet')).toBeTruthy();
    expect(screen.getByText('no sleep in range')).toBeTruthy();
    expect(screen.getByText('no steps in range')).toBeTruthy();
    expect(screen.getByText('No activities in range.')).toBeTruthy();
  });
});
