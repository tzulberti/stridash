-- Create per-sample performance series ("streams") for activities.
CREATE TABLE "activity_data_points" (
    "id" UUID NOT NULL,
    "activity_id" UUID NOT NULL,
    "provider" "Provider" NOT NULL,
    "sample_count" INTEGER NOT NULL,
    "series" JSONB NOT NULL,
    "raw" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "activity_data_points_pkey" PRIMARY KEY ("id")
);

COMMENT ON TABLE "activity_data_points" IS 'Per-sample series (time, position, distance, altitude, speed, HR, cadence, power) per activity+provider; arrays live in `series` jsonb';

-- An activity can arrive via multiple providers (Garmin AND Strava); one
-- series row per (activity, provider), richest wins at query time.
CREATE UNIQUE INDEX "activity_data_points_activity_id_provider_key" ON "activity_data_points"("activity_id", "provider");

ALTER TABLE "activity_data_points" ADD CONSTRAINT "activity_data_points_activity_id_fkey" FOREIGN KEY ("activity_id") REFERENCES "activities"("id") ON DELETE CASCADE ON UPDATE CASCADE;
