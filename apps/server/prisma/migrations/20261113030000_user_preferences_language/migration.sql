-- Account preference: UI language for the web dashboard (English default).
-- One typed column per setting, same pattern as units/theme.
CREATE TYPE "PrefLanguage" AS ENUM (
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
  'hi'
);

ALTER TABLE "user_preferences"
  ADD COLUMN "language" "PrefLanguage" NOT NULL DEFAULT 'en';
