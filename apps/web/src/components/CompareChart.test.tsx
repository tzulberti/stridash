import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { CompareChart } from './CompareChart';
import { setLocale, setUnit } from '../lib/format';
import { setLang } from '../lib/i18n/index';
import { COMPARE_A, COMPARE_B, type Point } from '../lib/chart';

beforeEach(() => {
  setLang('en');
  setLocale('en');
  setUnit('km');
});

afterEach(() => cleanup());

const a: Point[] = [
  { x: 0, y: 100 },
  { x: 1_000, y: 120 },
  { x: 2_000, y: 140 },
];
const b: Point[] = [
  { x: 0, y: 110 },
  { x: 1_000, y: 130 },
  { x: 2_000, y: 150 },
];

describe('CompareChart', () => {
  it('renders an empty state unless both series have two points', () => {
    const { rerender } = render(<CompareChart a={[]} b={b} />);
    expect(screen.getByText('not enough data')).toBeTruthy();

    rerender(<CompareChart a={a} b={[{ x: 0, y: 1 }]} />);
    expect(screen.getByText('not enough data')).toBeTruthy();
  });

  it('draws both series with the identity colors and a shared axis', () => {
    render(<CompareChart a={a} b={b} label="speed" unit=" km/h" />);

    const svg = screen.getByRole('img', { name: 'speed' });
    expect(svg.querySelectorAll(`path[stroke="${COMPARE_A}"]`)).toHaveLength(1);
    expect(svg.querySelectorAll(`path[stroke="${COMPARE_B}"]`)).toHaveLength(1);
    expect(screen.getByText('elapsed')).toBeTruthy();
  });

  it('uses the distance axis in distance mode', () => {
    render(<CompareChart a={a} b={b} xMode="distance" />);
    expect(screen.getByText('distance (km)')).toBeTruthy();
  });

  it('shows both hover values and clears the tooltip on leave', () => {
    render(<CompareChart a={a} b={b} label="speed" unit=" km/h" nameA="Ride A" nameB="Ride B" />);

    const svg = screen.getByRole('img', { name: 'speed' });
    vi.spyOn(svg, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 0,
      right: 900,
      bottom: 180,
      width: 900,
      height: 180,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect);
    fireEvent.mouseMove(svg, { clientX: 450 });

    expect(svg.querySelector('.chart-tip')).toBeTruthy();
    expect(screen.getByText('Ride A')).toBeTruthy();
    expect(screen.getByText('Ride B')).toBeTruthy();
    const values = Array.from(svg.querySelectorAll('.chart-tip-val')).map((n) => n.textContent);
    expect(values.join(' ')).toContain('km/h');

    fireEvent.mouseLeave(svg);
    expect(svg.querySelector('.chart-tip')).toBeNull();
  });
});
