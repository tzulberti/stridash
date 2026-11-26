import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ConnectionsSection, type ConnectionRow } from './ConnectionsSection';
import { setLang } from '../lib/i18n/index';

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }));
vi.mock('../lib/api', () => ({ api: apiMock }));

const conns: ConnectionRow[] = [
  {
    id: 'c1',
    provider: 'GARMIN',
    providerUserId: 'rider@example.com',
    status: 'ACTIVE',
    lastSyncedAt: '2026-11-20T08:00:00.000Z',
  },
  {
    id: 'c2',
    provider: 'ZWIFT',
    providerUserId: '',
    status: 'ERROR',
    lastSyncedAt: null,
  },
  {
    id: 'c3',
    provider: 'IGPSPORT',
    providerUserId: 'igps',
    status: 'PENDING',
    lastSyncedAt: null,
  },
];

const baseProps = {
  conn: conns,
  token: 'tok',
  syncingId: null as string | null,
  syncConnection: vi.fn(),
  reload: vi.fn(),
  onBack: vi.fn(),
};

function renderSection(over: Partial<typeof baseProps> = {}) {
  return render(<ConnectionsSection {...baseProps} {...over} />);
}

beforeEach(() => {
  setLang('en');
  baseProps.syncConnection.mockReset();
  baseProps.syncConnection.mockResolvedValue({ ok: true, text: 'queued' });
  baseProps.reload.mockReset();
  baseProps.onBack.mockReset();
  apiMock.mockReset();
  apiMock.mockResolvedValue({});
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('ConnectionsSection', () => {
  it('shows the empty state when no providers are linked', () => {
    renderSection({ conn: [] });
    expect(screen.getByText(/no providers linked yet/)).toBeTruthy();
  });

  it('renders provider cards with status, identity and last-sync lines', () => {
    renderSection();

    expect(screen.getByText('Garmin')).toBeTruthy();
    expect(screen.getByText('rider@example.com')).toBeTruthy();
    expect(screen.getByText('active')).toBeTruthy();
    expect(screen.getByText('error')).toBeTruthy();
    expect(screen.getByText('pending')).toBeTruthy();
    // ERROR card explains reconnecting
    expect(screen.getByText(/reconnect/i)).toBeTruthy();
    expect(screen.getAllByText(/last sync/).length).toBe(3);
  });

  it('runs a sync and renders the result on that card', async () => {
    baseProps.syncConnection.mockResolvedValueOnce({ ok: false, text: 'boom' });
    renderSection();

    fireEvent.click(screen.getAllByRole('button', { name: '↻ sync now' })[0]!);

    await waitFor(() => expect(baseProps.syncConnection).toHaveBeenCalledWith('c1'));
    expect(await screen.findByText(/sync failed — boom/)).toBeTruthy();
  });

  it('disables sync while another sync runs and for pending connections', () => {
    renderSection();
    const buttons = screen.getAllByRole('button', { name: '↻ sync now' }) as HTMLButtonElement[];
    expect(buttons[0]!.disabled).toBe(false);
    expect(buttons[2]!.disabled).toBe(true); // PENDING

    cleanup();
    renderSection({ syncingId: 'c1' });
    const busy = screen.getAllByRole('button', { name: '↻ sync now' }) as HTMLButtonElement[];
    expect(busy[0]!.disabled).toBe(true);
    expect(screen.getByText(/syncing/)).toBeTruthy();
  });

  it('soft-deletes after confirmation and reloads', async () => {
    renderSection();

    fireEvent.click(screen.getAllByRole('button', { name: 'delete' })[0]!);
    expect(screen.getByText(/delete this connection/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'yes, delete' }));

    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith('/connections/c1', { method: 'DELETE', token: 'tok' }),
    );
    expect(baseProps.reload).toHaveBeenCalledTimes(1);
  });

  it('connects Omron with the country and clears the credentials', async () => {
    renderSection();

    fireEvent.change(screen.getByPlaceholderText('Omron email or username'), {
      target: { value: 'scale@example.com' },
    });
    fireEvent.change(screen.getByPlaceholderText('password (verified, never stored in clear)'), {
      target: { value: 'secret' },
    });
    fireEvent.change(screen.getByPlaceholderText('AR'), { target: { value: 'br' } });
    fireEvent.click(screen.getByRole('button', { name: 'connect' }));

    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith('/connections', {
        method: 'POST',
        token: 'tok',
        body: {
          provider: 'OMRON',
          identifier: 'scale@example.com',
          password: 'secret',
          country: 'BR',
        },
      }),
    );
    expect(await screen.findByText(/Omron connected/)).toBeTruthy();
    expect(baseProps.reload).toHaveBeenCalled();
    expect((screen.getByPlaceholderText('Omron email or username') as HTMLInputElement).value).toBe(
      '',
    );
  });

  it('switches provider-specific body fields', async () => {
    renderSection();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'garmin' } });
    expect(screen.getByPlaceholderText('Garmin email')).toBeTruthy();

    fireEvent.change(screen.getByPlaceholderText('Garmin email'), {
      target: { value: 'rider@example.com' },
    });
    fireEvent.change(screen.getByPlaceholderText('password (verified, never stored in clear)'), {
      target: { value: 'secret' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'connect' }));

    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith('/connections', {
        method: 'POST',
        token: 'tok',
        body: { provider: 'GARMIN', email: 'rider@example.com', password: 'secret' },
      }),
    );
  });

  it('parks Garmin MFA and verifies the code', async () => {
    apiMock.mockImplementation(async (path: string) => {
      if (path === '/connections') {
        return { mfaRequired: true, method: 'email', connection: { id: 'c9' } };
      }
      return {};
    });
    renderSection();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'garmin' } });
    fireEvent.change(screen.getByPlaceholderText('Garmin email'), {
      target: { value: 'rider@example.com' },
    });
    fireEvent.change(screen.getByPlaceholderText('password (verified, never stored in clear)'), {
      target: { value: 'secret' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'connect' }));

    expect(await screen.findByText(/second-factor code/)).toBeTruthy();
    const code = screen.getByPlaceholderText('123456');
    fireEvent.change(code, { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: 'verify' }));

    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith('/connections/c9/mfa', {
        method: 'POST',
        token: 'tok',
        body: { code: '123456' },
      }),
    );
    expect(await screen.findByText(/Garmin connected/)).toBeTruthy();
  });

  it('surfaces connect and delete failures', async () => {
    apiMock.mockRejectedValueOnce(new Error('bad credentials'));
    renderSection();
    fireEvent.change(screen.getByPlaceholderText('Omron email or username'), {
      target: { value: 'scale@example.com' },
    });
    fireEvent.change(screen.getByPlaceholderText('password (verified, never stored in clear)'), {
      target: { value: 'wrong' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'connect' }));
    expect(await screen.findByText('bad credentials')).toBeTruthy();

    apiMock.mockRejectedValueOnce(new Error('delete failed'));
    fireEvent.click(screen.getAllByRole('button', { name: 'delete' })[0]!);
    fireEvent.click(screen.getByRole('button', { name: 'yes, delete' }));
    expect(await screen.findByText('delete failed')).toBeTruthy();
  });
});
