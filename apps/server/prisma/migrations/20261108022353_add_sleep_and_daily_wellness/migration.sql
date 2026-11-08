-- AlterEnum
ALTER TYPE "SyncKind" ADD VALUE 'WELLNESS';

-- CreateTable
CREATE TABLE "sleep_sessions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "provider" "Provider" NOT NULL,
    "date_key" TEXT NOT NULL,
    "start_at" TIMESTAMPTZ(6) NOT NULL,
    "end_at" TIMESTAMPTZ(6),
    "total_sleep_s" INTEGER,
    "deep_s" INTEGER,
    "light_s" INTEGER,
    "rem_s" INTEGER,
    "awake_s" INTEGER,
    "nap_s" INTEGER,
    "awake_count" INTEGER,
    "avg_sleep_stress" DECIMAL(5,1),
    "avg_hr" INTEGER,
    "avg_respiration" DECIMAL(4,1),
    "resting_hr" INTEGER,
    "hrvStatus" TEXT,
    "hrv_avg" DECIMAL(5,1),
    "body_battery_change" INTEGER,
    "sleep_need_min" INTEGER,
    "sleep_score" INTEGER,
    "raw" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "sleep_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "daily_wellness" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "provider" "Provider" NOT NULL,
    "date_key" TEXT NOT NULL,
    "steps" INTEGER,
    "steps_goal" INTEGER,
    "distance_m" DECIMAL(8,1),
    "floors_asc" INTEGER,
    "floors_desc" INTEGER,
    "active_cal" INTEGER,
    "resting_cal" INTEGER,
    "total_cal" INTEGER,
    "hr_min" INTEGER,
    "hr_max" INTEGER,
    "resting_hr" INTEGER,
    "moderate_min" INTEGER,
    "vigorous_min" INTEGER,
    "intensity_goal" INTEGER,
    "stress_avg" DOUBLE PRECISION,
    "stress_max" DOUBLE PRECISION,
    "battery_min" INTEGER,
    "battery_max" INTEGER,
    "battery_latest" INTEGER,
    "raw" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "daily_wellness_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sleep_sessions_user_id_date_key_idx" ON "sleep_sessions"("user_id", "date_key");

-- CreateIndex
CREATE UNIQUE INDEX "sleep_sessions_user_id_provider_date_key_key" ON "sleep_sessions"("user_id", "provider", "date_key");

-- CreateIndex
CREATE INDEX "daily_wellness_user_id_date_key_idx" ON "daily_wellness"("user_id", "date_key");

-- CreateIndex
CREATE UNIQUE INDEX "daily_wellness_user_id_provider_date_key_key" ON "daily_wellness"("user_id", "provider", "date_key");

-- AddForeignKey
ALTER TABLE "sleep_sessions" ADD CONSTRAINT "sleep_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sleep_sessions" ADD CONSTRAINT "sleep_sessions_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "daily_wellness" ADD CONSTRAINT "daily_wellness_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "daily_wellness" ADD CONSTRAINT "daily_wellness_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;
