-- Providers with a detail endpoint (Zwift) report far more than the list
-- row: workout identity hashes, session/session-ride ids, snapshots, ride
-- social data, profile anchors, FIT file coordinates. Store as-received;
-- anything Stridash promotes to a column stays the curated view.
ALTER TABLE "activities" ADD COLUMN "detail_raw" JSONB;
