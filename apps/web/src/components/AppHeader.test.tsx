import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { AppHeader } from './AppHeader';
import { setLang } from '../lib/i18n/index';

const baseProps = {
  goHome: vi.fn(),
  openConnections: vi.fn(),
  openGear: vi.fn(),
  openSettings: vi.fn(),
  signOut: vi.fn(),
};

beforeEach(() => {
  setLang('en');
  for (const fn of Object.values(baseProps)) fn.mockReset();
});

afterEach(() => cleanup());

describe('AppHeader', () => {
  it('opens the menu and routes to each page', () => {
    render(<AppHeader {...baseProps} />);
    const menu = screen.getByRole('button', { name: 'menu' });
    expect(menu.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('link', { name: 'Gear' })).toBeNull();

    fireEvent.click(menu);
    expect(menu.getAttribute('aria-expanded')).toBe('true');

    fireEvent.click(screen.getByRole('link', { name: 'Providers Sync' }));
    expect(baseProps.openConnections).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'menu' }));
    fireEvent.click(screen.getByRole('link', { name: 'Gear' }));
    expect(baseProps.openGear).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'menu' }));
    fireEvent.click(screen.getByRole('link', { name: 'Settings' }));
    expect(baseProps.openSettings).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'menu' }));
    fireEvent.click(screen.getByRole('button', { name: 'Sign Out' }));
    expect(baseProps.signOut).toHaveBeenCalledTimes(1);
  });

  it('goes home from the brand', () => {
    render(<AppHeader {...baseProps} />);
    fireEvent.click(screen.getByRole('link', { name: /Stridash/ }));
    expect(baseProps.goHome).toHaveBeenCalledTimes(1);
  });

  it('closes the menu on an outside click', () => {
    render(<AppHeader {...baseProps} />);
    fireEvent.click(screen.getByRole('button', { name: 'menu' }));
    expect(screen.getByRole('link', { name: 'Gear' })).toBeTruthy();

    fireEvent.click(document.body);
    expect(screen.queryByRole('link', { name: 'Gear' })).toBeNull();
  });
});
