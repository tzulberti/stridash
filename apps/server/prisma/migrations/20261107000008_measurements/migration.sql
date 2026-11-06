-- CreateEnum
CREATE TYPE "MeasurementKind" AS ENUM ('WEIGH_IN', 'BLOOD_PRESSURE');

-- CreateTable
CREATE TABLE "measurements" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "connection_id" UUID,
    "kind" "MeasurementKind" NOT NULL,
    "measured_at" TIMESTAMPTZ NOT NULL,
    "weight_kg" DECIMAL(6,2) NOT NULL,
    "body_fat_pct" DECIMAL(5,2),
    "muscle_mass_kg" DECIMAL(6,2),
    "skeletal_muscle_pct" DECIMAL(5,2),
    "bmi" DECIMAL(5,2),
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
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "measurements_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "measurements_connection_id_kind_measured_at_key" ON "measurements"("connection_id", "kind", "measured_at");

-- CreateIndex
CREATE INDEX "measurements_user_id_measured_at_idx" ON "measurements"("user_id", "measured_at");

-- AddForeignKey
ALTER TABLE "measurements" ADD CONSTRAINT "measurements_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "measurements" ADD CONSTRAINT "measurements_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "connections"("id") ON DELETE SET NULL ON UPDATE CASCADE;
