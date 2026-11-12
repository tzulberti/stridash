-- Recording devices: watches / cycling head units that produce activities.
-- One row per (user, provider, source_device_id); activities link to the
-- device that recorded them (nullable — backfilled by sync passes).

CREATE TABLE "devices" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "provider" "Provider" NOT NULL,
    "source_device_id" TEXT NOT NULL,
    "manufacturer" TEXT,
    "model" TEXT,
    "product_code" INTEGER,
    "software_version" TEXT,
    "hardware_version" TEXT,
    "raw" JSONB,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "devices_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "devices_user_id_provider_source_device_id_key" ON "devices"("user_id", "provider", "source_device_id");

ALTER TABLE "devices" ADD CONSTRAINT "devices_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "activities" ADD COLUMN "device_id" UUID;
ALTER TABLE "activities" ADD CONSTRAINT "activities_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE SET NULL ON UPDATE CASCADE;
