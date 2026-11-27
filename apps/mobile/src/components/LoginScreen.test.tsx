import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { LoginScreen } from './LoginScreen';

const { login, register } = vi.hoisted(() => ({ login: vi.fn(), register: vi.fn() }));
vi.mock('@/lib/api', () => ({ login, register }));
vi.mock('react-native-safe-area-context', () => ({
  SafeAreaView: ({ children }: { children?: unknown }) => <>{children}</>,
}));

const onTokens = vi.fn();

beforeEach(() => {
  login.mockReset();
  register.mockReset();
  onTokens.mockReset();
  login.mockResolvedValue({ accessToken: 'at', refreshToken: 'rt' });
  register.mockResolvedValue({
    accessToken: 'at',
    refreshToken: 'rt',
    user: { email: 'a@b.c' },
  });
});

afterEach(() => cleanup());

describe('LoginScreen', () => {
  it('logs in and hands the token pair to the app', async () => {
    render(<LoginScreen onTokens={onTokens} />);

    fireEvent.change(screen.getByPlaceholderText('email'), {
      target: { value: 'alice@example.com' },
    });
    fireEvent.change(screen.getByPlaceholderText('password'), {
      target: { value: 'secret' },
    });
    fireEvent.click(screen.getByText('Sign in'));

    await waitFor(() => expect(login).toHaveBeenCalledWith('alice@example.com', 'secret'));
    expect(onTokens).toHaveBeenCalledWith({ accessToken: 'at', refreshToken: 'rt' });
  });

  it('registers with a display name', async () => {
    render(<LoginScreen onTokens={onTokens} />);
    fireEvent.click(screen.getByText('Need an account? Create one'));

    fireEvent.change(screen.getByPlaceholderText('display name'), {
      target: { value: 'Alice' },
    });
    fireEvent.change(screen.getByPlaceholderText('email'), {
      target: { value: 'new@example.com' },
    });
    fireEvent.change(screen.getByPlaceholderText('password'), {
      target: { value: 'long-enough-password' },
    });
    fireEvent.click(screen.getByText('Create account'));

    await waitFor(() =>
      expect(register).toHaveBeenCalledWith('new@example.com', 'long-enough-password', 'Alice'),
    );
    expect(onTokens).toHaveBeenCalledWith({ accessToken: 'at', refreshToken: 'rt' });
  });

  it('shows an API error and stays on the form', async () => {
    login.mockRejectedValueOnce(new Error('Invalid email or password'));
    render(<LoginScreen onTokens={onTokens} />);

    fireEvent.change(screen.getByPlaceholderText('email'), {
      target: { value: 'alice@example.com' },
    });
    fireEvent.change(screen.getByPlaceholderText('password'), {
      target: { value: 'wrong' },
    });
    fireEvent.click(screen.getByText('Sign in'));

    expect(await screen.findByText('Invalid email or password')).toBeTruthy();
    expect(onTokens).not.toHaveBeenCalled();
  });
});
