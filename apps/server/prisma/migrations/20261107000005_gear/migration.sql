-- CreateEnum
CREATE TYPE "GearKind" AS ENUM ('BIKE', 'SHOES', 'OTHER');

-- CreateTable
CREATE TABLE "gear" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "GearKind" NOT NULL DEFAULT 'OTHER',
    "brand" TEXT,
    "model" TEXT,
    "retired" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "gear_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "gear_user_id_idx" ON "gear"("user_id");

-- AddForeignKey
ALTER TABLE "gear" ADD CONSTRAINT "gear_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
