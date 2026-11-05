import { Hono } from "hono";
import { prisma } from "../db.js";
import { requireUserId } from "../auth.js";
import type { Env } from "../env.js";

/** Endpoints for the user's own provider connections. Read-only for M1:
 * connecting live providers arrives with M2 (Strava OAuth). */
export function connectionRoutes(env: Env): Hono<{ Variables: { userId: string } }> {
  const routes = new Hono<{ Variables: { userId: string } }>();

  routes.use("*", async (c, next) => {
    c.set("userId", await requireUserId(c, env.STRIDASH_JWT_SECRET));
    await next();
  });

  routes.get("/", async (c) => {
    const connections = await prisma.connection.findMany({
      where: { userId: c.get("userId") },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        provider: true,
        providerUserId: true,
        status: true,
        scopes: true,
        lastSyncedAt: true,
        createdAt: true,
        updatedAt: true,
        // tokens deliberately excluded — never leave the server
      },
    });

    return c.json({ items: connections, nextCursor: null });
  });

  return routes;
}
