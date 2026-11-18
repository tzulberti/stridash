-- D1: provider-side identity is the real key for activity_sources. Before the
-- shared ingest service, the same provider activity could be linked to two
-- activity rows (the old findFirst + create race). Collapse those provenance
-- duplicates first: keep the row pointing at the oldest activity, drop the
-- rest. Activity rows are deliberately untouched — merging stored duplicate
-- activities is the separate cleanup pass (D2).

WITH ranked AS (
    SELECT s."activity_id",
           s."connection_id",
           row_number() OVER (
               PARTITION BY s."connection_id", s."source_activity_id"
               ORDER BY a."created_at" ASC, s."activity_id" ASC
           ) AS rn
    FROM "activity_sources" s
    JOIN "activities" a ON a."id" = s."activity_id"
)
DELETE FROM "activity_sources" s
USING ranked r
WHERE s."activity_id" = r."activity_id"
  AND s."connection_id" = r."connection_id"
  AND r.rn > 1;

CREATE UNIQUE INDEX "activity_sources_connection_id_source_activity_id_key"
    ON "activity_sources"("connection_id", "source_activity_id");
