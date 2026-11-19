-- Manual sync lock: claim atomically before dispatching, clear when done.
-- A crashed process leaves the timestamp behind; the route takes over after
-- a stale interval (15 minutes) so a connection cannot stay locked forever.
ALTER TABLE "connections" ADD COLUMN "sync_started_at" TIMESTAMPTZ(6);
