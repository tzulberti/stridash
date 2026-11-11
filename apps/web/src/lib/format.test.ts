/**
 * Pure display + URL-state helper tests (lib/format.ts). These pin the
 * dashboard's user-visible formatting and the deep-link parsing contract.
 */

import { describe, it, expect } from 'vitest';
import {
  fmtKm,
  fmtMin,
  fmtSpeed,
  fmtPace,
  fmtSplitTime,
  fmtDate,
  TYPE_EMOJI,
  FEED_TYPES,
  FEED_PROVIDERS,
  keyOf,
  pick,
  isoDate,
  parseRoute,
} from './format';

describe('formatters', () => {
  it('fmtKm renders metres as kilometres, — for null', () => {
    expect(fmtKm(22_400)).toBe('22.40 km');
    expect(fmtKm(0)).toBe('0.00 km');
    expect(fmtKm(null)).toBe('—');
    expect(fmtKm(undefined)).toBe('—');
  });

  it('fmtMin renders the exact duration (m:ss, or h:mm:ss over an hour)', () => {
    expect(fmtMin(1_402)).toBe('23:22');
    expect(fmtMin(1_402.7)).toBe('23:23'); // fractional seconds round once
    expect(fmtMin(3_661)).toBe('1:01:01');
    expect(fmtMin(null)).toBe('—');
  });

  it('fmtSpeed converts m/s to km/h', () => {
    expect(fmtSpeed(8.396)).toBe('30.2 km/h');
    expect(fmtSpeed(null)).toBe('—');
  });

  it('fmtPace renders min/km and rejects non-finite values', () => {
    expect(fmtPace(372)).toBe('6:12 /km');
    expect(fmtPace(59)).toBe('0:59 /km');
    expect(fmtPace(null)).toBe('—');
    expect(fmtPace(Number.NaN)).toBe('—');
    expect(fmtPace(Number.POSITIVE_INFINITY)).toBe('—');
  });

  it('fmtSplitTime renders h:mm:ss only when hours are warranted', () => {
    expect(fmtSplitTime(59)).toBe('0:59');
    expect(fmtSplitTime(59.6)).toBe('1:00'); // rounds the total, never "0:60"
    expect(fmtSplitTime(3_725)).toBe('1:02:05');
  });

  it('fmtDate falls back to — for absent values', () => {
    expect(fmtDate(undefined)).toBe('—');
    expect(fmtDate('2026-11-08T18:00:00Z')).toContain('2026'); // locale varies; year is stable
  });
});

describe('feed constants', () => {
  it('emoji covers every activity type in the feed list', () => {
    for (const t of FEED_TYPES) expect(TYPE_EMOJI[t]).toBeTruthy();
    expect(TYPE_EMOJI.UNKNOWN_KEY).toBeUndefined();
  });

  it('provider list matches the connections the server knows', () => {
    expect(FEED_PROVIDERS).toContain('ZWIFT');
    expect(FEED_PROVIDERS).not.toContain('PELOTON');
  });
});

describe('keyOf (metric deep-links)', () => {
  it('accepts only known members, falling back otherwise', () => {
    expect(keyOf(['weightKg', 'bodyFatPct'], 'bodyFatPct', 'weightKg')).toBe('bodyFatPct');
    expect(keyOf(['weightKg', 'bodyFatPct'], 'hacked', 'weightKg')).toBe('weightKg');
    expect(keyOf(['weightKg', 'bodyFatPct'], null, 'weightKg')).toBe('weightKg');
  });
});

describe('pick (feed-filter deep-links)', () => {
  it('accepts whitelisted values, empty string otherwise (no filter)', () => {
    expect(pick(FEED_TYPES, 'VIRTUAL_RIDE')).toBe('VIRTUAL_RIDE');
    expect(pick(FEED_TYPES, 'SLEEP')).toBe('');
    expect(pick(FEED_PROVIDERS, 'ZWIFT')).toBe('ZWIFT');
    expect(pick(FEED_PROVIDERS, null)).toBe('');
  });
});

describe('isoDate (range deep-links)', () => {
  it('accepts YYYY-MM-DD only', () => {
    expect(isoDate('2026-11-08')).toBe('2026-11-08');
    expect(isoDate('2026-11')).toBeUndefined();
    expect(isoDate('not-a-date')).toBeUndefined();
    expect(isoDate(null)).toBeUndefined();
  });
});

describe('parseRoute (client routing)', () => {
  it('routes /connections (with or without trailing slash)', () => {
    expect(parseRoute('/connections')).toEqual({ name: 'connections' });
    expect(parseRoute('/connections/')).toEqual({ name: 'connections' });
  });

  it('routes /gear (with or without trailing slash)', () => {
    expect(parseRoute('/gear')).toEqual({ name: 'gear' });
    expect(parseRoute('/gear/')).toEqual({ name: 'gear' });
  });

  it('routes /settings (with or without trailing slash)', () => {
    expect(parseRoute('/settings')).toEqual({ name: 'settings' });
    expect(parseRoute('/settings/')).toEqual({ name: 'settings' });
  });

  it('extracts the activity id', () => {
    expect(parseRoute('/activity/01a1c541-b7d4-77d0-b568-5f2bc6078ec0')).toEqual({
      name: 'activity',
      id: '01a1c541-b7d4-77d0-b568-5f2bc6078ec0',
    });
    expect(parseRoute('/activity/abc?x=distance').name).toBe('activity');
  });

  it('lands on the dashboard for everything else', () => {
    expect(parseRoute('/')).toEqual({ name: 'dashboard' });
    expect(parseRoute('/activity/')).toEqual({ name: 'dashboard' });
    expect(parseRoute('/totally/unknown/path')).toEqual({ name: 'dashboard' });
  });
});
