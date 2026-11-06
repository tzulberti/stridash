-- Add per-connection provider config (non-secret metadata, e.g. Omron country).
ALTER TABLE "connections" ADD COLUMN "config" JSONB;

-- Provider registry grows with the integrations actually being built
-- (Omron today; Zwift and iGPSPORT next).
ALTER TYPE "Provider" ADD VALUE IF NOT EXISTS 'ZWIFT';
ALTER TYPE "Provider" ADD VALUE IF NOT EXISTS 'IGPSPORT';
