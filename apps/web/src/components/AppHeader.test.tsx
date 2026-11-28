import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { AppHeader } from './AppHeader';
import { setLang } from '../lib/i18n/index';

const baseProps = {
  current: 'dashboard',
  goHome: vi.fn(),
  openSearch: vi.fn(),
  openConnections: vi.fn(),
  openGear: vi.fn(),
  openSettings: vi.fn(),
  signOut: vi.fn(),
};

beforeEach(() => {
  setLang('en');
  for (const fn of Object.values(baseProps)) if (typeof fn === 'function') fn.mockReset();
});

afterEach(() => cleanup());

describe('AppHeader', () => {
  it('routes to each page from the primary navigation', () => {
    render(<AppHeader {...baseProps} />);

    fireEvent.click(screen.getByRole('link', { name: 'Advanced search' }));
    expect(baseProps.openSearch).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('link', { name: 'Providers Sync' }));
    expect(baseProps.openConnections).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('link', { name: 'Gear' }));
    expect(baseProps.openGear).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('link', { name: 'Settings' }));
    expect(baseProps.openSettings).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Sign Out' }));
    expect(baseProps.signOut).toHaveBeenCalledTimes(1);
  });

  it('marks the active page with aria-current', () => {
    const { rerender } = render(<AppHeader {...baseProps} current="settings" />);
    expect(screen.getByRole('link', { name: 'Settings' }).getAttribute('aria-current')).toBe(
      'page',
    );
    expect(screen.getByRole('link', { name: 'Gear' }).getAttribute('aria-current')).toBeNull();

    rerender(<AppHeader {...baseProps} current="search" />);
    expect(screen.getByRole('link', { name: 'Advanced search' }).getAttribute('aria-current')).toBe(
      'page',
    );

    rerender(<AppHeader {...baseProps} current="gear" />);
    expect(screen.getByRole('link', { name: 'Gear' }).getAttribute('aria-current')).toBe('page');
  });

  it('goes home from the brand', () => {
    render(<AppHeader {...baseProps} />);
    fireEvent.click(screen.getByRole('link', { name: /Stridash/ }));
    expect(baseProps.goHome).toHaveBeenCalledTimes(1);
  });
});
