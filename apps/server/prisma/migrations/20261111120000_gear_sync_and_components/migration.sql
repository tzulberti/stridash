-- Gear becomes provider-syncable (Garmin gear-service v2) and gains
-- wear-item components with replace-by-usage tracking.
--
-- The `retired` boolean is replaced by `retired_at` (the provider carries a
-- date, and "when" is what usage windows need). The table predates any
-- sync — it is empty, so the column swap is trivially safe.

ALTER TABLE "gear"
    ADD COLUMN "provider" "Provider",
    ADD COLUMN "source_gear_id" TEXT,
    ADD COLUMN "first_used_at" DATE,
    ADD COLUMN "retired_at" DATE,
    ADD COLUMN "usage_type" TEXT,
    ADD COLUMN "threshold_m" DECIMAL(10,1),
    ADD COLUMN "raw" JSONB;

ALTER TABLE "gear" DROP COLUMN "retired";

-- manual gear rows (provider/source_gear_id NULL) are exempt: Postgres
-- treats NULLs as distinct in unique indexes
CREATE UNIQUE INDEX "gear_user_id_provider_source_gear_id_key" ON "gear"("user_id", "provider", "source_gear_id");

-- Stridash-managed components: chains, brake pads, tires, shoe insoles…
-- Usage is COMPUTED from the activities linked to the parent gear that
-- start on/after installed_at — nothing is stored per-activity here.
CREATE TYPE "GearComponentKind" AS ENUM (
    'CHAIN',
    'CASSETTE',
    'CHAINRING',
    'BRAKE_PADS',
    'TIRES',
    'TUBES',
    'PEDALS',
    'BATTERY',
    'OTHER'
);

CREATE TABLE "gear_components" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "gear_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "GearComponentKind" NOT NULL DEFAULT 'OTHER',
    "installed_at" DATE,
    "retired_at" DATE,
    "threshold_m" DECIMAL(10,1),
    "notes" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "gear_components_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "gear_components_gear_id_idx" ON "gear_components"("gear_id");
CREATE INDEX "gear_components_user_id_idx" ON "gear_components"("user_id");

ALTER TABLE "gear_components" ADD CONSTRAINT "gear_components_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "gear_components" ADD CONSTRAINT "gear_components_gear_id_fkey" FOREIGN KEY ("gear_id") REFERENCES "gear"("id") ON DELETE CASCADE ON UPDATE CASCADE;
