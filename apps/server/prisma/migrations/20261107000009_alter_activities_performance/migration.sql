-- Add the performance metrics that scalar summaries were missing.
ALTER TABLE "activities"
    ADD COLUMN "total_descent_m" DECIMAL(8,2),
    ADD COLUMN "elevation_high_m" DECIMAL(7,2),
    ADD COLUMN "elevation_low_m" DECIMAL(7,2),
    ADD COLUMN "hr_zones_min" JSONB,
    ADD COLUMN "avg_cadence" INTEGER,
    ADD COLUMN "max_cadence" INTEGER,
    ADD COLUMN "training_load" INTEGER;

    -- Report why the descent column exists
    COMMENT ON COLUMN "activities"."total_descent_m" IS 'Cumulative descent in meters, when the source reports it';
