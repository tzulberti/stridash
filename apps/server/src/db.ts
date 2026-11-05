import { PrismaClient } from "@prisma/client";

/** Global Prisma singleton (survives tsx watch restarts without exhausting connections). */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma = globalForPrisma.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
