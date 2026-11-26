import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { DatePicker } from './DatePicker';
import { setLang } from '../lib/i18n/index';
import { setLocale } from '../lib/format';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-27T12:00:00Z'));
  setLang('en');
  setLocale('en');
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function open(value = '', props: Partial<React.ComponentProps<typeof DatePicker>> = {}) {
  const onChange = vi.fn();
  const view = render(
    <DatePicker value={value} onChange={onChange} placeholder="Start date" {...props} />,
  );
  fireEvent.click(screen.getByRole('button', { name: /Start date|2026/ }));
  return { onChange, view };
}

describe('DatePicker', () => {
  it('shows the placeholder and opens the current month', () => {
    render(<DatePicker value="" onChange={vi.fn()} placeholder="Start date" />);
    const trigger = screen.getByRole('button', { name: /Start date/ });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(trigger);

    expect(screen.getByRole('dialog', { name: 'Start date' })).toBeTruthy();
    expect(screen.getByText('November 2026')).toBeTruthy();
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    // 42 day cells + weekday header
    expect(screen.getByRole('dialog').querySelectorAll('.dp-day')).toHaveLength(42);
  });

  it('selects a day and closes the popover', () => {
    const { onChange } = open();

    fireEvent.click(screen.getByRole('button', { name: '15' }));

    expect(onChange).toHaveBeenCalledWith('2026-11-15');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('reflects a controlled value and marks it selected', () => {
    const { view } = open('2026-11-15');
    const selected = screen.getByRole('button', { name: '15' });
    expect(selected.className).toContain('sel');

    view.rerender(<DatePicker value="2026-12-02" onChange={vi.fn()} placeholder="Start date" />);
    expect(screen.getByRole('button', { name: /2026-12-02/ })).toBeTruthy();
  });

  it('navigates months and preserves Monday-first weekday headers', () => {
    open();
    expect(screen.getByText('Mon')).toBeTruthy();
    expect(screen.getByText('Sun')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'next month' }));
    expect(screen.getByText('December 2026')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'previous month' }));
    expect(screen.getByText('November 2026')).toBeTruthy();
  });

  it('disables days outside the inclusive min/max bounds', () => {
    open('', { min: '2026-11-10', max: '2026-11-20' });

    expect((screen.getByRole('button', { name: '9' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: '10' }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole('button', { name: '20' }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole('button', { name: '21' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('clears, picks today, and disables clear when already empty', () => {
    const { onChange, view } = open('2026-11-15');
    fireEvent.click(screen.getByRole('button', { name: 'clear' }));
    expect(onChange).toHaveBeenCalledWith('');
    expect(screen.queryByRole('dialog')).toBeNull();

    view.rerender(<DatePicker value="" onChange={onChange} placeholder="Start date" />);
    fireEvent.click(screen.getByRole('button', { name: /Start date/ }));
    expect((screen.getByRole('button', { name: 'clear' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    fireEvent.click(screen.getByRole('button', { name: 'today' }));
    expect(onChange).toHaveBeenLastCalledWith('2026-11-27');
  });

  it('closes on Escape and on an outside click', () => {
    open();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Start date/ }));
    expect(screen.getByRole('dialog')).toBeTruthy();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
