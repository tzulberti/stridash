import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ConnectionForm } from './ConnectionForm';

const { connectProvider, stravaAuthorizeUrl, verifyConnectionMfa, openBrowserAsync } = vi.hoisted(
  () => ({
    connectProvider: vi.fn(),
    stravaAuthorizeUrl: vi.fn(),
    verifyConnectionMfa: vi.fn(),
    openBrowserAsync: vi.fn(),
  }),
);
vi.mock('@/lib/api', () => ({ connectProvider, stravaAuthorizeUrl, verifyConnectionMfa }));
vi.mock('expo-web-browser', () => ({ openBrowserAsync }));

const onConnected = vi.fn();

beforeEach(() => {
  connectProvider.mockReset();
  stravaAuthorizeUrl.mockReset();
  verifyConnectionMfa.mockReset();
  openBrowserAsync.mockReset();
  onConnected.mockReset();
  connectProvider.mockResolvedValue({ status: 'ACTIVE' });
  verifyConnectionMfa.mockResolvedValue({ status: 'ACTIVE' });
  stravaAuthorizeUrl.mockResolvedValue({ url: 'https://www.strava.com/oauth/authorize?state=s' });
});

afterEach(() => cleanup());

describe('ConnectionForm', () => {
  it('connects Omron with the country', async () => {
    render(<ConnectionForm token="tok" onConnected={onConnected} />);
    fireEvent.click(screen.getByText('Add a connection'));

    fireEvent.change(screen.getByPlaceholderText('Omron email or username'), {
      target: { value: 'scale@example.com' },
    });
    fireEvent.change(screen.getByPlaceholderText('password (verified, never stored in clear)'), {
      target: { value: 'secret' },
    });
    fireEvent.change(screen.getByPlaceholderText('Omron country code (e.g. AR)'), {
      target: { value: 'br' },
    });
    fireEvent.click(screen.getByText('Connect'));

    await waitFor(() =>
      expect(connectProvider).toHaveBeenCalledWith('tok', {
        provider: 'OMRON',
        identifier: 'scale@example.com',
        password: 'secret',
        country: 'BR',
      }),
    );
    expect(await screen.findByText(/Omron connected/)).toBeTruthy();
    expect(onConnected).toHaveBeenCalled();
  });

  it('parks Garmin MFA and verifies the code', async () => {
    connectProvider.mockResolvedValueOnce({
      mfaRequired: true,
      method: 'email',
      connection: { id: 'c9' },
    });
    render(<ConnectionForm token="tok" onConnected={onConnected} />);
    fireEvent.click(screen.getByText('Add a connection'));
    fireEvent.click(screen.getByText('Garmin'));

    fireEvent.change(screen.getByPlaceholderText('Garmin email'), {
      target: { value: 'rider@example.com' },
    });
    fireEvent.change(screen.getByPlaceholderText('password (verified, never stored in clear)'), {
      target: { value: 'secret' },
    });
    fireEvent.click(screen.getByText('Connect'));

    expect(await screen.findByText('Garmin needs a second-factor code.')).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText('email code'), {
      target: { value: '123456' },
    });
    fireEvent.click(screen.getByText('Verify'));

    await waitFor(() => expect(verifyConnectionMfa).toHaveBeenCalledWith('tok', 'c9', '123456'));
    expect(onConnected).toHaveBeenCalled();
  });

  it('opens the Strava consent URL in the browser', async () => {
    render(<ConnectionForm token="tok" onConnected={onConnected} />);
    fireEvent.click(screen.getByText('Add a connection'));
    fireEvent.click(screen.getByText('Strava'));
    fireEvent.click(screen.getByText('Open Strava consent'));

    await waitFor(() =>
      expect(openBrowserAsync).toHaveBeenCalledWith(
        'https://www.strava.com/oauth/authorize?state=s',
      ),
    );
    expect(await screen.findByText(/Finish the Strava consent/)).toBeTruthy();
  });

  it('shows a connect error', async () => {
    connectProvider.mockRejectedValueOnce(new Error('bad credentials'));
    render(<ConnectionForm token="tok" onConnected={onConnected} />);
    fireEvent.click(screen.getByText('Add a connection'));
    fireEvent.change(screen.getByPlaceholderText('Omron email or username'), {
      target: { value: 'scale@example.com' },
    });
    fireEvent.change(screen.getByPlaceholderText('password (verified, never stored in clear)'), {
      target: { value: 'wrong' },
    });
    fireEvent.click(screen.getByText('Connect'));

    expect(await screen.findByText('bad credentials')).toBeTruthy();
    expect(onConnected).not.toHaveBeenCalled();
  });
});
