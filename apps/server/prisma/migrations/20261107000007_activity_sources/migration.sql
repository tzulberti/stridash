-- CreateTable
CREATE TABLE "activity_sources" (
    "activity_id" TEXT NOT NULL,
    "connection_id" TEXT NOT NULL,
    "source_activity_id" TEXT NOT NULL,
    "source_updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "activity_sources_pkey" PRIMARY KEY ("activity_id","connection_id")
);

-- AddForeignKey
ALTER TABLE "activity_sources" ADD CONSTRAINT "activity_sources_activity_id_fkey" FOREIGN KEY ("activity_id") REFERENCES "activities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activity_sources" ADD CONSTRAINT "activity_sources_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;
