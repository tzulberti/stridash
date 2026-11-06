import path from "node:path";
import { defineConfig } from "prisma/config";

// Prisma 7 moved datasource/env config out of schema.prisma — see
// https://www.prisma.io/docs/orm/prisma-config
export default defineConfig({
  schema: path.join(import.meta.dirname, "prisma", "schema.prisma"),
  migrations: {
    path: path.join(import.meta.dirname, "prisma", "migrations"),
  },
  datasource: {
    url: process.env.DATABASE_URL ?? "postgresql://stridash:stridash@localhost:5433/stridash?schema=public",
  },
});
