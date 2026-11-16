/**
 * stanceTimePctFrom — the shared FIT parser's dual-spelling stance-time
 * mapping. Garmin firmware writes either stance_time_percent (already a
 * percentage) or stance_time (ground contact time in ms); iGPSPORT files
 * carry neither.
 */

import { describe, it, expect } from 'vitest';
import { stanceTimePctFrom } from '../src/providers/igpsport/fit.js';

describe('stanceTimePctFrom', () => {
  it('prefers stance_time_percent when both spellings are present', () => {
    expect(stanceTimePctFrom({ stance_time_percent: 36.75, stance_time: 266, cadence: 87 })).toBe(
      36.75,
    );
  });

  it('converts stance_time (ms) via cadence — per-foot cycle is 60/cadence s', () => {
    // 228 ms ground contact at 87 steps/min per foot → 228 × 87 / 600 ≈ 33.06 %
    expect(stanceTimePctFrom({ stance_time: 228, cadence: 87 })).toBeCloseTo(33.06, 2);
  });

  it('adds fractional_cadence before converting', () => {
    expect(
      stanceTimePctFrom({ stance_time: 228, cadence: 87, fractional_cadence: 0.5 }),
    ).toBeCloseTo(33.25, 2);
  });

  it('carries no stance when cadence is missing, zero, or not a number', () => {
    expect(stanceTimePctFrom({ stance_time: 228 })).toBeUndefined();
    expect(stanceTimePctFrom({ stance_time: 228, cadence: 0 })).toBeUndefined();
    expect(stanceTimePctFrom({ stance_time: 228, cadence: 'x' })).toBeUndefined();
  });

  it('carries no stance when neither spelling is present', () => {
    expect(stanceTimePctFrom({ cadence: 87 })).toBeUndefined();
    expect(stanceTimePctFrom({})).toBeUndefined();
  });
});
