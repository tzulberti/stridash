/**
 * Tiny dependency-free i18n for the dashboard (same pattern as lib/format.ts:
 * module-level setting, set before render so every t() call in the tree
 * speaks the chosen language).
 *
 * - `Lang`: the 12 shipped languages (English default).
 * - `t(key, vars?)`: dictionary lookup with `{name}` interpolation; falls
 *   back to the English string, then the key itself.
 * - `LANGUAGES`: code → native name (shown in the Settings picker) + the
 *   Intl locale used for dates/months/weekdays.
 * - `setLang` mirrors `setUnit`: the App calls it on boot (localStorage
 *   value), on account adoption (/me answer) and on Settings changes.
 */

import { en, type MsgKey } from './en.js';
import { es } from './es.js';
import { pt } from './pt.js';
import { fr } from './fr.js';
import { de } from './de.js';
import { it } from './it.js';
import { nl } from './nl.js';
import { ru } from './ru.js';
import { ja } from './ja.js';
import { ko } from './ko.js';
import { zh } from './zh.js';
import { hi } from './hi.js';

export type Lang =
  'en' | 'es' | 'pt' | 'fr' | 'de' | 'it' | 'nl' | 'ru' | 'ja' | 'ko' | 'zh' | 'hi';

export const LANGUAGES: ReadonlyArray<{ code: Lang; name: string; locale: string }> = [
  { code: 'en', name: 'English', locale: 'en' },
  { code: 'es', name: 'Español', locale: 'es' },
  { code: 'pt', name: 'Português', locale: 'pt' },
  { code: 'fr', name: 'Français', locale: 'fr' },
  { code: 'de', name: 'Deutsch', locale: 'de' },
  { code: 'it', name: 'Italiano', locale: 'it' },
  { code: 'nl', name: 'Nederlands', locale: 'nl' },
  { code: 'ru', name: 'Русский', locale: 'ru' },
  { code: 'ja', name: '日本語', locale: 'ja' },
  { code: 'ko', name: '한국어', locale: 'ko' },
  { code: 'zh', name: '简体中文', locale: 'zh-CN' },
  { code: 'hi', name: 'हिन्दी', locale: 'hi' },
];

const DICTS: Record<Lang, Record<MsgKey, string>> = {
  en,
  es,
  pt,
  fr,
  de,
  it,
  nl,
  ru,
  ja,
  ko,
  zh,
  hi,
};

let lang: Lang = 'en';

export function getLang(): Lang {
  return lang;
}

export function setLang(l: Lang): void {
  if (l in DICTS) lang = l;
}

/** Intl locale tag for the active language (dates, months, weekdays). */
export function localeOf(l: Lang = lang): string {
  return LANGUAGES.find((x) => x.code === l)?.locale ?? 'en';
}

/** Translate `key` in the active language, falling back to English, then the
 * key itself. `{name}` slots are replaced when `vars` is given. */
export function t(key: MsgKey, vars?: Record<string, string | number>): string {
  let s: string = DICTS[lang][key] ?? en[key] ?? key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v));
  }
  return s;
}

export type { MsgKey } from './en.js';
