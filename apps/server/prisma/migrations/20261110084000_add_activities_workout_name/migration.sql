-- Zwift workout identity: workout activities are named "Zwift - <workout name>"
-- (free rides are not), and users want to see WHICH routine they repeated.
ALTER TABLE "activities" ADD COLUMN IF NOT EXISTS "workout_name" TEXT;

-- deterministic backfill for already-ingested Zwift rows ('Zwift - ' = 8 chars)
UPDATE "activities" a
SET "workout_name" = SUBSTRING(a."headline" FROM 9)
FROM "activity_sources" s
JOIN "connections" c ON c."id" = s."connection_id"
WHERE s."activity_id" = a."id"
  AND c."provider" = 'ZWIFT'
  AND a."headline" LIKE 'Zwift - %';
