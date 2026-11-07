import { Hono } from "hono";
import { z } from "zod";
import { prisma } from "../db.js";
import { requireUserId } from "../auth.js";
import type { Env } from "../env.js";

const listQuerySchema = z.object({
  /** ISO date lower bound (activities.start_time / measurements.measured_at) */
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().optional(),
});

/** Serialization helper: Prisma Decimals→number, Dates→ISO strings. */
function serializeRow(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(row).map(([k, v]) => {
      if (v instanceof Date) return [k, v.toISOString()];
      if (typeof v === "object" && v !== null && "toFixed" in v && typeof (v as any).toFixed === "function") {
        return [k, Number(v)]; // Prisma Decimal
      }
      return [k, v];
    }),
  );
}

export function dataRoutes(env: Env): Hono<{ Variables: { userId: string } }> {
  const routes = new Hono<{ Variables: { userId: string } }>();

  routes.use("*", async (c, next) => {
    c.set("userId", await requireUserId(c, env.STRIDASH_JWT_SECRET));
    await next();
  });

  routes.get("/activities", async (c) => {
    const q = listQuerySchema.safeParse(c.req.query());
    if (!q.success) return c.json({ error: "Invalid query", detail: q.error.flatten().fieldErrors }, 400);

    const items = await prisma.activity.findMany({
      where: {
        userId: c.get("userId"),
        ...(q.data.from || q.data.to
          ? { startTime: { ...(q.data.from ? { gte: new Date(q.data.from) } : {}), ...(q.data.to ? { lte: new Date(q.data.to) } : {}) } }
          : {}),
      },
      orderBy: { startTime: "desc" },
      take: q.data.limit,
      ...(q.data.cursor ? { cursor: { id: q.data.cursor } } : {}),
    });

    return c.json({
      items: items.map((a) => serializeRow(a)),
      nextCursor: items.length === q.data.limit ? (items.at(-1)?.id ?? null) : null,
    });
  });

  routes.get("/activities/:id", async (c) => {
    const id = c.req.param("id");
    const activity = await prisma.activity.findFirst({
      where: { id, userId: c.get("userId") },
    });
    if (!activity) return c.json({ error: "Not found" }, 404);
    const points = await prisma.activityDataPoint.findMany({
      where: { activityId: id },
      select: { provider: true, sampleCount: true, series: true },
    });
    return c.json({ items: [{ ...serializeRow(activity), series: points }] });
  });

  routes.get("/measurements", async (c) => {
    const q = listQuerySchema.safeParse(c.req.query());
    if (!q.success) return c.json({ error: "Invalid query", detail: q.error.flatten().fieldErrors }, 400);

    const items = await prisma.measurement.findMany({
      where: {
        userId: c.get("userId"),
        ...(q.data.from || q.data.to
          ? { measuredAt: { ...(q.data.from ? { gte: new Date(q.data.from) } : {}), ...(q.data.to ? { lte: new Date(q.data.to) } : {}) } }
          : {}),
      },
      orderBy: { measuredAt: "desc" },
      take: q.data.limit,
      ...(q.data.cursor ? { cursor: { id: q.data.cursor } } : {}),
    });

    return c.json({
      items: items.map((m) => serializeRow(m)),
      nextCursor: items.length === q.data.limit ? (items.at(-1)?.id ?? null) : null,
    });
  });

  return routes;
}
