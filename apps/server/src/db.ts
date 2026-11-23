import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, type Prisma } from './generated/prisma/client.js';
import { loadDatabaseUrl } from './env.js';

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

/** Global Prisma singleton (survives tsx watch restarts without exhausting connections). */
export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    adapter: new PrismaPg({ connectionString: loadDatabaseUrl() }),
  });

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;
