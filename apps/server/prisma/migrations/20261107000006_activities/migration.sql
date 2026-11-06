-- CreateEnum
CREATE TYPE "ActivityType" AS ENUM ('RUN', 'RIDE', 'VIRTUAL_RIDE', 'WALK', 'HIKE', 'SWIM', 'WORKOUT', 'OTHER');

-- CreateTable
CREATE TABLE "activities" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "headline" TEXT NOT NULL,
    "type" "ActivityType" NOT NULL,
    "start_time" TIMESTAMPTZ NOT NULL,
    "duration_s" INTEGER NOT NULL,
    "moving_time_s" INTEGER,
    "distance_m" DECIMAL(10,2),
    "total_ascent_m" DECIMAL(8,2),
    "avg_speed_ms" DECIMAL(6,2),
    "max_speed_ms" DECIMAL(6,2),
    "avg_hr" INTEGER,
    "max_hr" INTEGER,
    "avg_power_w" INTEGER,
    "max_power_w" INTEGER,
    "calories_kcal" INTEGER,
    "indoor" BOOLEAN NOT NULL DEFAULT false,
    "gear_id" TEXT,
    "notes" TEXT,
    "raw" JSONB,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "activities_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "activities_user_id_start_time_idx" ON "activities"("user_id", "start_time");

-- CreateIndex
CREATE UNIQUE INDEX "activities_user_id_start_time_type_distance_m_key" ON "activities"("user_id", "start_time", "type", "distance_m");

-- AddForeignKey
ALTER TABLE "activities" ADD CONSTRAINT "activities_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activities" ADD CONSTRAINT "activities_gear_id_fkey" FOREIGN KEY ("gear_id") REFERENCES "gear"("id") ON DELETE SET NULL ON UPDATE CASCADE;
