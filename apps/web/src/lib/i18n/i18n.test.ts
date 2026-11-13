/**
 * i18n contract tests. English (en.ts) is the key source of truth — every
 * other dictionary must carry exactly the same key set (TypeScript already
 * enforces this at compile time; these runtime checks also catch
 * accidentally-added keys and pin the lookup/interpolation behaviour).
 */

import { describe, it, expect, afterEach } from 'vitest';
import { en, type MsgKey } from './en';
import { es } from './es';
import { pt } from './pt';
import { fr } from './fr';
import { de } from './de';
import { it as itDict } from './it';
import { nl } from './nl';
import { ru } from './ru';
import { ja } from './ja';
import { ko } from './ko';
import { zh } from './zh';
import { hi } from './hi';
import { LANGUAGES, getLang, setLang, localeOf, t } from './index';

const DICTS: Record<string, Record<string, string>> = {
  es,
  pt,
  fr,
  de,
  it: itDict,
  nl,
  ru,
  ja,
  ko,
  zh,
  hi,
};

const enKeys = Object.keys(en).sort();

// every test leaves the module-level language as it found it
afterEach(() => setLang('en'));

describe('dictionaries', () => {
  it('English is non-empty and the key source of truth', () => {
    expect(enKeys.length).toBeGreaterThan(100);
    expect(new Set(enKeys).size).toBe(enKeys.length); // no duplicate keys
  });

  for (const [code, dict] of Object.entries(DICTS)) {
    it(`${code} has exactly the English keys (all translated)`, () => {
      expect(Object.keys(dict).sort()).toEqual(enKeys);
      for (const k of enKeys) {
        expect(typeof dict[k]).toBe('string');
        expect((dict[k] as string).length).toBeGreaterThan(0);
      }
    });
  }

  it('LANGUAGES lists 12 unique codes, English first', () => {
    expect(LANGUAGES).toHaveLength(12);
    expect(LANGUAGES.map((l) => l.code)).toEqual([
      'en',
      'es',
      'pt',
      'fr',
      'de',
      'it',
      'nl',
      'ru',
      'ja',
      'ko',
      'zh',
      'hi',
    ]);
    expect(new Set(LANGUAGES.map((l) => l.code)).size).toBe(12);
    for (const l of LANGUAGES) {
      expect(l.name.length).toBeGreaterThan(0);
      expect(l.locale).toBeTruthy();
    }
    expect(LANGUAGES[0]).toMatchObject({ code: 'en', name: 'English', locale: 'en' });
    expect(localeOf('zh')).toBe('zh-CN');
  });
});

describe('t()', () => {
  it('returns the English string on the default language', () => {
    setLang('en');
    expect(t('auth.tagline')).toBe(en['auth.tagline']);
  });

  it('switches with the active language (setLang mirrors setUnit)', () => {
    setLang('es');
    expect(t('auth.tagline')).toBe(es['auth.tagline']);
    setLang('ja');
    expect(t('auth.tagline')).toBe(ja['auth.tagline']);
    expect(getLang()).toBe('ja');
  });

  it('ignores unknown language codes', () => {
    setLang('es');
    setLang('xx' as never);
    expect(getLang()).toBe('es');
  });

  it('interpolates {name} slots with vars', () => {
    setLang('en');
    expect(t('conn.lastSync', { date: '2026-11-13 10:00' })).not.toContain('{date}');
    expect(t('conn.lastSync', { date: '2026-11-13 10:00' })).toContain('2026-11-13 10:00');
  });

  it('interpolation applies even to unknown keys (final fallback is the key)', () => {
    setLang('en');
    expect(t('x {n} y' as MsgKey, { n: 5 })).toBe('x 5 y');
    expect(t('no.such.key' as MsgKey)).toBe('no.such.key');
  });
});

describe('localeOf()', () => {
  it('follows the active language with a per-language Intl locale', () => {
    setLang('en');
    expect(localeOf()).toBe('en');
    setLang('de');
    expect(localeOf()).toBe('de');
    setLang('zh');
    expect(localeOf()).toBe('zh-CN');
  });
});
