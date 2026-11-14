-- Physiology columns surfaced from Garmin: sweat loss + the two training
-- effects and their benefit messages live in the Connect list row
-- (raw.listRow); Vo2max / recovery time / normalized power come from the FIT
-- session message (raw.session). Backfill reads the payloads already stored
-- (the raw payload is the authority), so existing activities light up
-- without a re-sync.
--
-- NOTE: the FIT recovery_time field is minutes — the stored session key was
-- named recoveryTimeH before the unit was confirmed. Ingests since then
-- store recoveryMinutes; the backfill COALESCEs both eras.

ALTER TABLE "activities" ADD COLUMN "sweat_loss_ml" DOUBLE PRECISION;
ALTER TABLE "activities" ADD COLUMN "aerobic_te" DOUBLE PRECISION;
ALTER TABLE "activities" ADD COLUMN "anaerobic_te" DOUBLE PRECISION;
ALTER TABLE "activities" ADD COLUMN "aerobic_te_message" TEXT;
ALTER TABLE "activities" ADD COLUMN "anaerobic_te_message" TEXT;
ALTER TABLE "activities" ADD COLUMN "vo2max" DOUBLE PRECISION;
ALTER TABLE "activities" ADD COLUMN "recovery_minutes" DOUBLE PRECISION;
ALTER TABLE "activities" ADD COLUMN "normalized_power_w" DOUBLE PRECISION;

UPDATE "activities" SET
    "sweat_loss_ml" = ("raw"->'listRow'->>'waterEstimated')::DOUBLE PRECISION,
    "aerobic_te" = COALESCE(
        ("raw"->'session'->>'totalTrainingEffect')::DOUBLE PRECISION,
        ("raw"->'listRow'->>'aerobicTrainingEffect')::DOUBLE PRECISION),
    "anaerobic_te" = COALESCE(
        ("raw"->'session'->>'totalAnaerobicTrainingEffect')::DOUBLE PRECISION,
        ("raw"->'listRow'->>'anaerobicTrainingEffect')::DOUBLE PRECISION),
    "aerobic_te_message" = "raw"->'listRow'->>'aerobicTrainingEffectMessage',
    "anaerobic_te_message" = "raw"->'listRow'->>'anaerobicTrainingEffectMessage',
    "vo2max" = COALESCE(
        ("raw"->'session'->>'vo2Max')::DOUBLE PRECISION,
        ("raw"->'listRow'->>'vO2MaxValue')::DOUBLE PRECISION),
    "recovery_minutes" = COALESCE(
        ("raw"->'session'->>'recoveryMinutes')::DOUBLE PRECISION,
        ("raw"->'session'->>'recoveryTimeH')::DOUBLE PRECISION),
    "normalized_power_w" = COALESCE(
        ("raw"->'session'->>'normalizedPowerW')::DOUBLE PRECISION,
        ("raw"->'listRow'->>'normPower')::DOUBLE PRECISION)
WHERE "raw" ? 'listRow' OR "raw" ? 'session';
