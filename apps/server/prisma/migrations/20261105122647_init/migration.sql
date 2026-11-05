-- CreateEnum
CREATE TYPE "Sex" AS ENUM ('MALE', 'FEMALE', 'OTHER', 'UNDISCLOSED');

-- CreateEnum
CREATE TYPE "IdentityKind" AS ENUM ('PASSWORD');

-- CreateEnum
CREATE TYPE "Provider" AS ENUM ('STRAVA', 'GARMIN', 'OMRON', 'MANUAL');

-- CreateEnum
CREATE TYPE "ConnectionStatus" AS ENUM ('PENDING', 'ACTIVE', 'ERROR', 'REVOKED');

-- CreateEnum
CREATE TYPE "SyncKind" AS ENUM ('ACTIVITIES', 'MEASUREMENTS', 'TOKEN_REFRESH');

-- CreateEnum
CREATE TYPE "SyncStatus" AS ENUM ('OK', 'PARTIAL', 'ERROR');

-- CreateEnum
CREATE TYPE "ActivityType" AS ENUM ('RUN', 'RIDE', 'VIRTUAL_RIDE', 'WALK', 'HIKE', 'SWIM', 'WORKOUT', 'OTHER');

-- CreateEnum
CREATE TYPE "GearKind" AS ENUM ('BIKE', 'SHOES', 'OTHER');

-- CreateEnum
CREATE TYPE "MeasurementKind" AS ENUM ('WEIGH_IN', 'BLOOD_PRESSURE');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "height_cm" DECIMAL(65,30),
    "date_of_birth" DATE,
    "sex" "Sex",
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_identities" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "kind" "IdentityKind" NOT NULL DEFAULT 'PASSWORD',
    "secret_hash" TEXT NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "auth_identities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "connections" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "provider" "Provider" NOT NULL,
    "provider_user_id" TEXT NOT NULL,
    "status" "ConnectionStatus" NOT NULL DEFAULT 'PENDING',
    "access_token_enc" TEXT,
    "refresh_token_enc" TEXT,
    "token_expires_at" TIMESTAMP(3),
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "last_synced_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_logs" (
    "id" TEXT NOT NULL,
    "connection_id" TEXT NOT NULL,
    "kind" "SyncKind" NOT NULL,
    "status" "SyncStatus" NOT NULL,
    "items_pulled" INTEGER NOT NULL DEFAULT 0,
    "items_created" INTEGER NOT NULL DEFAULT 0,
    "items_updated" INTEGER NOT NULL DEFAULT 0,
    "error_detail" JSONB,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),

    CONSTRAINT "sync_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "activities" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "headline" TEXT NOT NULL,
    "type" "ActivityType" NOT NULL,
    "start_time" TIMESTAMP(3) NOT NULL,
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
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "activities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "activity_sources" (
    "activity_id" TEXT NOT NULL,
    "connection_id" TEXT NOT NULL,
    "source_activity_id" TEXT NOT NULL,
    "source_updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "activity_sources_pkey" PRIMARY KEY ("activity_id","connection_id")
);

-- CreateTable
CREATE TABLE "gear" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "GearKind" NOT NULL DEFAULT 'OTHER',
    "brand" TEXT,
    "model" TEXT,
    "retired" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "gear_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "measurements" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "connection_id" TEXT,
    "kind" "MeasurementKind" NOT NULL,
    "measured_at" TIMESTAMP(3) NOT NULL,
    "weight_kg" DECIMAL(6,2) NOT NULL,
    "body_fat_pct" DECIMAL(5,2),
    "muscle_mass_kg" DECIMAL(6,2),
    "skeletal_muscle_pct" DECIMAL(5,2),
    "bmi" DECIMAL(65,30),
    "visceral_fat_level" DECIMAL(4,1),
    "resting_metabolism_kcal" INTEGER,
    "metabolic_age" INTEGER,
    "subcutaneous_fat_pct" DECIMAL(5,2),
    "fat_free_mass_kg" DECIMAL(6,2),
    "fat_mass_kg" DECIMAL(6,2),
    "skeletal_muscle_mass_kg" DECIMAL(6,2),
    "impedance_ohm" DECIMAL(6,2),
    "body_water_pct" DECIMAL(5,2),
    "bone_mass_kg" DECIMAL(6,2),
    "systolic_mmhg" INTEGER,
    "diastolic_mmhg" INTEGER,
    "pulse_bpm" INTEGER,
    "mean_arterial_pressure" DECIMAL(5,2),
    "notes" TEXT,
    "segments" JSONB,
    "raw" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "measurements_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "connections_user_id_provider_provider_user_id_key" ON "connections"("user_id", "provider", "provider_user_id");

-- CreateIndex
CREATE INDEX "sync_logs_connection_id_started_at_idx" ON "sync_logs"("connection_id", "started_at");

-- CreateIndex
CREATE UNIQUE INDEX "activities_user_id_start_time_type_distance_m_key" ON "activities"("user_id", "start_time", "type", "distance_m");

-- CreateIndex
CREATE INDEX "measurements_user_id_measured_at_idx" ON "measurements"("user_id", "measured_at");

-- CreateIndex
CREATE UNIQUE INDEX "measurements_connection_id_kind_measured_at_key" ON "measurements"("connection_id", "kind", "measured_at");

-- AddForeignKey
ALTER TABLE "auth_identities" ADD CONSTRAINT "auth_identities_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "connections" ADD CONSTRAINT "connections_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_logs" ADD CONSTRAINT "sync_logs_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activities" ADD CONSTRAINT "activities_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activities" ADD CONSTRAINT "activities_gear_id_fkey" FOREIGN KEY ("gear_id") REFERENCES "gear"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activity_sources" ADD CONSTRAINT "activity_sources_activity_id_fkey" FOREIGN KEY ("activity_id") REFERENCES "activities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activity_sources" ADD CONSTRAINT "activity_sources_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gear" ADD CONSTRAINT "gear_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "measurements" ADD CONSTRAINT "measurements_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "measurements" ADD CONSTRAINT "measurements_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "connections"("id") ON DELETE SET NULL ON UPDATE CASCADE;
