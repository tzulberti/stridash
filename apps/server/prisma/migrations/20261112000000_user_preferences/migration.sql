-- Account preferences live in a real table with one typed column per
-- setting (units, theme) — deliberately NOT a jsonb blob: each setting gets
-- a Postgres type, a default and a visible home in the schema. One row per
-- user; the FK cascades so account deletion removes it.

CREATE TYPE "PrefUnit" AS ENUM ('km', 'mi');
CREATE TYPE "PrefTheme" AS ENUM ('dark', 'light');

CREATE TABLE "user_preferences" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "units" "PrefUnit" NOT NULL DEFAULT 'km',
    "theme" "PrefTheme" NOT NULL DEFAULT 'dark',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "user_preferences_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "user_preferences_user_id_key" ON "user_preferences"("user_id");

ALTER TABLE "user_preferences" ADD CONSTRAINT "user_preferences_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- every existing user starts with the same defaults the UI had before
-- preferences were persisted (km, dark)
INSERT INTO "user_preferences" ("id", "user_id", "updated_at")
SELECT gen_random_uuid(), "id", now()
FROM "users";
