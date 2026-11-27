import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ChartChannelConfig, ChartProvider, MeResponse } from '@stridash/types';
import { SettingsSection } from './SettingsSection';
import { setLang } from '../lib/i18n/index';

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }));
vi.mock('../lib/api', () => ({ api: apiMock }));

const me: MeResponse = {
  email: 'alice@example.com',
  displayName: 'Alice',
  createdAt: '2026-01-02T03:04:05.000Z',
} as MeResponse;

const baseProps = {
  token: 'tok',
  unit: 'km' as const,
  onUnitChange: vi.fn(),
  theme: 'light' as const,
  onThemeChange: vi.fn(),
  lang: 'en' as const,
  onLangChange: vi.fn(),
  chartChannels: {} as Partial<Record<ChartProvider, ChartChannelConfig[]>>,
  onChartChannelsChange: vi.fn(),
  onDeleted: vi.fn(),
  onBack: vi.fn(),
};

function renderSettings(over: Partial<typeof baseProps> = {}) {
  return render(<SettingsSection {...baseProps} {...over} />);
}

beforeEach(() => {
  setLang('en');
  for (const fn of [
    baseProps.onUnitChange,
    baseProps.onThemeChange,
    baseProps.onLangChange,
    baseProps.onChartChannelsChange,
    baseProps.onDeleted,
    baseProps.onBack,
  ]) {
    fn.mockReset();
  }
  apiMock.mockReset();
  apiMock.mockImplementation(async (path: string, opts?: { method?: string }) => {
    if (path === '/me' && !opts?.method) return me;
    return {};
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('SettingsSection', () => {
  it('loads the account summary', async () => {
    renderSettings();
    expect(screen.getByText('Loading…')).toBeTruthy();

    expect(await screen.findByText('alice@example.com')).toBeTruthy();
    expect(screen.getByText('Alice')).toBeTruthy();
    expect(screen.getByText('2026-01-02')).toBeTruthy();
    expect(apiMock).toHaveBeenCalledWith('/me', { token: 'tok' });
  });

  it('applies unit, theme and language changes optimistically then persists', async () => {
    renderSettings();
    await screen.findByText('alice@example.com');

    fireEvent.click(screen.getByRole('button', { name: 'miles' }));
    expect(baseProps.onUnitChange).toHaveBeenCalledWith('mi');
    expect(apiMock).toHaveBeenCalledWith('/me', {
      method: 'PATCH',
      token: 'tok',
      body: { units: 'mi' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'dark' }));
    expect(baseProps.onThemeChange).toHaveBeenCalledWith('dark');

    fireEvent.click(screen.getByRole('button', { name: 'Español' }));
    expect(baseProps.onLangChange).toHaveBeenCalledWith('es');
  });

  it('persists chart toggles through the provider endpoint', async () => {
    renderSettings();
    await screen.findByText('alice@example.com');

    fireEvent.click(
      screen.getAllByText('Respiration')[0]!.closest('label')!.querySelector('input')!,
    );

    expect(baseProps.onChartChannelsChange).toHaveBeenCalledTimes(1);
    const [provider, channels] = baseProps.onChartChannelsChange.mock.calls[0] as [
      ChartProvider,
      ChartChannelConfig[],
    ];
    expect(provider).toBe('GARMIN');
    expect(channels.find((c) => c.key === 'respirationRate')).toMatchObject({ visible: false });
    expect(apiMock).toHaveBeenCalledWith('/preferences/charts/GARMIN', {
      method: 'PUT',
      token: 'tok',
      body: { channels },
    });
  });

  it('downloads the JSON export and shows the success note', async () => {
    const blob = new Blob(['{"ok":true}'], { type: 'application/json' });
    const fetchMock = vi.fn(
      async () =>
        new Response(blob, {
          status: 200,
          headers: { 'Content-Disposition': 'attachment; filename="stridash-export.json"' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const createObjectURL = vi.fn(() => 'blob:stridash');
    const revokeObjectURL = vi.fn();
    Object.assign(URL, { createObjectURL, revokeObjectURL });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    renderSettings();
    await screen.findByText('alice@example.com');
    fireEvent.click(screen.getByRole('button', { name: 'Download my data (JSON)' }));

    expect(await screen.findByText('Export downloaded.')).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith('/api/export', {
      headers: { Authorization: 'Bearer tok' },
    });
    expect(createObjectURL).toHaveBeenCalled();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:stridash');
    expect(click).toHaveBeenCalled();
  });

  it('downloads activities CSV with the CSV endpoint', async () => {
    const blob = new Blob(['id,startTime\r\n'], { type: 'text/csv' });
    const fetchMock = vi.fn(
      async () =>
        new Response(blob, {
          status: 200,
          headers: { 'Content-Disposition': 'attachment; filename="stridash-activities.csv"' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const createObjectURL = vi.fn(() => 'blob:csv');
    const revokeObjectURL = vi.fn();
    Object.assign(URL, { createObjectURL, revokeObjectURL });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    renderSettings();
    await screen.findByText('alice@example.com');
    fireEvent.click(screen.getByRole('button', { name: 'Download activities CSV' }));

    expect(await screen.findByText('Export downloaded.')).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith('/api/export/csv?type=activities', {
      headers: { Authorization: 'Bearer tok' },
    });
    expect(createObjectURL).toHaveBeenCalled();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:csv');
    expect(click).toHaveBeenCalled();
  });

  it('surfaces an export failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 500 })),
    );
    renderSettings();
    await screen.findByText('alice@example.com');
    fireEvent.click(screen.getByRole('button', { name: 'Download my data (JSON)' }));

    expect(await screen.findByText('export failed (HTTP 500)')).toBeTruthy();
  });

  it('requires typing DELETE before deleting the account', async () => {
    renderSettings();
    await screen.findByText('alice@example.com');

    fireEvent.click(screen.getByRole('button', { name: 'Delete account…' }));
    const input = screen.getByPlaceholderText('type DELETE to confirm');
    const confirm = screen.getByRole('button', { name: 'Delete permanently' }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);

    fireEvent.change(input, { target: { value: 'delete' } });
    expect(confirm.disabled).toBe(true);
    fireEvent.change(input, { target: { value: 'DELETE' } });
    expect(confirm.disabled).toBe(false);

    fireEvent.click(confirm);
    await waitFor(() => expect(baseProps.onDeleted).toHaveBeenCalledTimes(1));
    expect(apiMock).toHaveBeenCalledWith('/me', { method: 'DELETE', token: 'tok' });
  });

  it('cancels the delete confirmation and reports load errors', async () => {
    apiMock.mockRejectedValueOnce(new Error('session expired'));
    renderSettings();

    expect(await screen.findByText('session expired')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Delete account…' }));
    fireEvent.click(screen.getByRole('button', { name: 'cancel' }));
    expect(screen.queryByPlaceholderText('type DELETE to confirm')).toBeNull();
  });
});
