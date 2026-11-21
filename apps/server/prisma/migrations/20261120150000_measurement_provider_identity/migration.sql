-- D3: identify measurements by (user, provider, kind, measured_at), not by
-- the connection row. Reconnecting Omron can create a new connection with a
-- different provider id but the same physical scale readings; the old key
-- therefore duplicated every weigh-in.
--
-- `provider` is backfilled from the owning connection (MANUAL for hand-entered
-- rows). Existing duplicates are collapsed before the unique index is created:
-- keep the most-populated row per new key, then the oldest as a tie-breaker.

ALTER TABLE "measurements" ADD COLUMN "provider" "Provider";

UPDATE "measurements" m
SET "provider" = c."provider"
FROM "connections" c
WHERE m."connection_id" = c."id";

UPDATE "measurements" SET "provider" = 'MANUAL' WHERE "provider" IS NULL;

WITH ranked AS (
    SELECT m."id",
           row_number() OVER (
               PARTITION BY m."user_id", m."provider", m."kind", m."measured_at"
               ORDER BY (
                   (m."weight_kg" IS NOT NULL)::int +
                   (m."body_fat_pct" IS NOT NULL)::int +
                   (m."muscle_mass_kg" IS NOT NULL)::int +
                   (m."skeletal_muscle_pct" IS NOT NULL)::int +
                   (m."bmi" IS NOT NULL)::int +
                   (m."visceral_fat_level" IS NOT NULL)::int +
                   (m."resting_metabolism_kcal" IS NOT NULL)::int +
                   (m."metabolic_age" IS NOT NULL)::int +
                   (m."subcutaneous_fat_pct" IS NOT NULL)::int +
                   (m."fat_free_mass_kg" IS NOT NULL)::int +
                   (m."fat_mass_kg" IS NOT NULL)::int +
                   (m."skeletal_muscle_mass_kg" IS NOT NULL)::int +
                   (m."impedance_ohm" IS NOT NULL)::int +
                   (m."body_water_pct" IS NOT NULL)::int +
                   (m."bone_mass_kg" IS NOT NULL)::int +
                   (m."systolic_mmhg" IS NOT NULL)::int +
                   (m."diastolic_mmhg" IS NOT NULL)::int +
                   (m."pulse_bpm" IS NOT NULL)::int +
                   (m."mean_arterial_pressure" IS NOT NULL)::int +
                   (m."notes" IS NOT NULL)::int +
                   (m."segments" IS NOT NULL)::int +
                   (m."raw" IS NOT NULL)::int
               ) DESC,
               m."created_at" ASC,
               m."id" ASC
           ) AS rn
    FROM "measurements" m
)
DELETE FROM "measurements" m
USING ranked r
WHERE m."id" = r."id" AND r.rn > 1;

ALTER TABLE "measurements" ALTER COLUMN "provider" SET NOT NULL;

DROP INDEX "measurements_connection_id_kind_measured_at_key";

CREATE UNIQUE INDEX "measurements_user_id_provider_kind_measured_at_key"
    ON "measurements"("user_id", "provider", "kind", "measured_at");
