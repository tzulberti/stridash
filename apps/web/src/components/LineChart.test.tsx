import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { LineChart } from './LineChart';
import { setLocale, setUnit } from '../lib/format';
import { setLang } from '../lib/i18n/index';
import type { Point } from '../lib/chart';

beforeEach(() => {
  setLang('en');
  setLocale('en');
  setUnit('km');
});

afterEach(() => cleanup());

const points: Point[] = [
  { x: 0, y: 100 },
  { x: 1_000, y: 120 },
  { x: 2_000, y: 140 },
];

describe('LineChart', () => {
  it('renders an empty state until there are at least two points', () => {
    const { rerender } = render(<LineChart points={[]} color="#fff" />);
    expect(screen.getByText('not enough data')).toBeTruthy();

    rerender(<LineChart points={[{ x: 0, y: 1 }]} color="#fff" />);
    expect(screen.getByText('not enough data')).toBeTruthy();
  });

  it('draws the line, points and axis labels', () => {
    render(<LineChart points={points} color="#3e8ef7" label="heart rate" unit=" bpm" />);

    const svg = screen.getByRole('img', { name: 'heart rate' });
    expect(svg.getAttribute('viewBox')).toBe('0 0 900 200');
    expect(svg.querySelectorAll('circle')).toHaveLength(3);
    expect(svg.querySelectorAll('path[stroke="#3e8ef7"]')).toHaveLength(1);
    expect(screen.getByText('elapsed')).toBeTruthy();
  });

  it('uses the distance axis in distance mode', () => {
    render(<LineChart points={points} color="#fff" xMode="distance" />);
    expect(screen.getByText('distance (km)')).toBeTruthy();
  });

  it('splits a zoned line into one path per heart-rate zone', () => {
    render(
      <LineChart
        points={[
          { x: 0, y: 100 },
          { x: 1_000, y: 140 },
          { x: 2_000, y: 180 },
        ]}
        color="#fff"
        zoneThresholds={[120, 160, Infinity]}
      />,
    );

    const svg = screen.getByRole('img');
    const paths = Array.from(svg.querySelectorAll('path[stroke]'));
    // midpoint of span 1 is 120 (Z2), span 2 is 160 (Z3)
    expect(paths).toHaveLength(2);
    expect(paths.map((p) => p.getAttribute('stroke'))).toEqual(['#3e8ef7', '#30a46c']);
    expect(svg.querySelectorAll('circle')).toHaveLength(3);
  });

  it('shows a hover tooltip with the value and zone, and clears on leave', () => {
    render(
      <LineChart
        points={[
          { x: 0, y: 100 },
          { x: 100_000, y: 150 },
          { x: 200_000, y: 180 },
        ]}
        color="#fff"
        unit=" bpm"
        zoneThresholds={[120, 160, Infinity]}
      />,
    );

    const svg = screen.getByRole('img');
    fireEvent.mouseMove(svg, { clientX: 100 });
    expect(svg.querySelector('.chart-tip')).toBeTruthy();
    expect(svg.querySelector('.chart-tip-val')?.textContent).toContain('bpm');
    expect(svg.querySelector('.chart-tip-val')?.textContent).toContain('Z1');

    fireEvent.mouseLeave(svg);
    expect(svg.querySelector('.chart-tip')).toBeNull();
  });
});
