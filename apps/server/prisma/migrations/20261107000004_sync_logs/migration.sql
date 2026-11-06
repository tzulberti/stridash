-- CreateEnum
CREATE TYPE "SyncKind" AS ENUM ('ACTIVITIES', 'MEASUREMENTS', 'TOKEN_REFRESH');

-- CreateEnum
CREATE TYPE "SyncStatus" AS ENUM ('OK', 'PARTIAL', 'ERROR');

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
    "started_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ,

    CONSTRAINT "sync_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sync_logs_connection_id_started_at_idx" ON "sync_logs"("connection_id", "started_at");

-- AddForeignKey
ALTER TABLE "sync_logs" ADD CONSTRAINT "sync_logs_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;
