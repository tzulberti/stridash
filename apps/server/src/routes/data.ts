import { Hono } from 'hono';
import { z } from 'zod';
import { prisma } from '../db.js';
import { requireUserId } from '../auth.js';
import type { Env } from '../env.js';

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
      if (
        typeof v === 'object' &&
        v !== null &&
        'toFixed' in v &&
        typeof (v as any).toFixed === 'function'
      ) {
        return [k, Number(v)]; // Prisma Decimal
      }
      return [k, v];
    }),
  );
}

export function dataRoutes(env: Env): Hono<{ Variables: { userId: string } }> {
  const routes = new Hono<{ Variables: { userId: string } }>();

  routes.use('*', async (c, next) => {
    c.set('userId', await requireUserId(c, env.STRIDASH_JWT_SECRET));
    await next();
  });

  routes.get('/me', async (c) => {
    const user = await prisma.user.findUnique({
      where: { id: c.get('userId') },
      select: { email: true, displayName: true, createdAt: true, preferences: true },
    });
    if (!user) return c.json({ error: 'Not found' }, 404);
    // a user without a preferences row (pre-migration edge) reads as defaults
    const { preferences, ...account } = user;
    return c.json({
      ...account,
      createdAt: user.createdAt.toISOString(),
      preferences: { units: preferences?.units ?? 'km', theme: preferences?.theme ?? 'dark' },
    });
  });

  /** Save account preferences — a typed column per setting on
   * user_preferences (no jsonb). Partial updates; unknown keys are 400s. */
  const preferencesSchema = z.object({
    units: z.enum(['km', 'mi']).optional(),
    theme: z.enum(['dark', 'light']).optional(),
  });

  routes.patch('/me', async (c) => {
    const parsed = preferencesSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json({ error: 'Invalid body', detail: parsed.error.flatten().fieldErrors }, 400);
    if (Object.keys(parsed.data).length === 0) return c.json({ error: 'Nothing to update' }, 400);

    const userId = c.get('userId');
    try {
      const preferences = await prisma.userPreferences.upsert({
        where: { userId },
        create: { userId, ...parsed.data },
        update: parsed.data,
      });
      return c.json({ preferences: { units: preferences.units, theme: preferences.theme } });
    } catch (err) {
      if (
        typeof err === 'object' &&
        err !== null &&
        'code' in err &&
        (err as { code?: string }).code === 'P2003'
      ) {
        // FK violation = the user row is gone (deleted account, stale token)
        return c.json({ error: 'Not found' }, 404);
      }
      throw err;
    }
  });

  // ─── Account data: full export + hard delete ───────────────────────────────

  /** Full JSON dump of everything this user's account holds ("raw payload is
   * the authority" — activities carry their raw/detail payloads as-received).
   * Per-sample series (activity_data_points, ~1 row per activity) are NOT
   * included: they dominate the payload (100k+ samples/year). Everything
   * else — scalars, raw payloads, provenance, measurements, sleep, wellness,
   * gear — is in here. */
  routes.get('/export', async (c) => {
    const userId = c.get('userId');
    const [user, connections, activities, measurements, sleepSessions, dailyWellness, gear] =
      await Promise.all([
        prisma.user.findUnique({
          where: { id: userId },
          select: { email: true, displayName: true, createdAt: true },
        }),
        prisma.connection.findMany({
          where: { userId },
          // tokens are NEVER exported — they're credentials, not data
          select: {
            provider: true,
            providerUserId: true,
            status: true,
            createdAt: true,
            lastSyncedAt: true,
          },
        }),
        prisma.activity.findMany({
          where: { userId },
          orderBy: { startTime: 'asc' },
          include: {
            sources: {
              select: { connectionId: true, sourceActivityId: true, sourceUpdatedAt: true },
            },
          },
        }),
        prisma.measurement.findMany({ where: { userId }, orderBy: { measuredAt: 'asc' } }),
        prisma.sleepSession.findMany({ where: { userId }, orderBy: { dateKey: 'asc' } }),
        prisma.dailyWellness.findMany({ where: { userId }, orderBy: { dateKey: 'asc' } }),
        prisma.gear.findMany({
          where: { userId },
          include: { components: { orderBy: { createdAt: 'asc' } } },
        }),
      ]);

    const dump = {
      exportedAt: new Date().toISOString(),
      format: 'stridash-export/1',
      note: 'Per-sample activity series (the FIT "stream" rows) are not part of this dump; every activity carries its scalars, raw provider payloads and provenance. Tokens/secrets are never exported.',
      account: user,
      connections,
      // serializeRow: Prisma Decimals → JSON numbers, Dates → ISO strings
      activities: activities.map((a) => ({ ...serializeRow(a), sources: a.sources })),
      measurements: measurements.map(serializeRow),
      sleepSessions: sleepSessions.map(serializeRow),
      dailyWellness: dailyWellness.map(serializeRow),
      gear: gear.map((g) => ({
        ...serializeRow(g),
        components: g.components.map(serializeRow),
      })),
    };
    const filename = `stridash-export-${new Date().toISOString().slice(0, 10)}.json`;
    return new Response(JSON.stringify(dump, null, 1), {
      headers: {
        'Content-Type': 'application/json',
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
    });
  });

  /** Hard delete: the user row cascades to connections, activities,
   * measurements, sleep, wellness, gear, components and refresh tokens
   * (every FK from users is ON DELETE CASCADE). Irreversible. */
  routes.delete('/me', async (c) => {
    await prisma.user.delete({ where: { id: c.get('userId') } });
    return c.json({ ok: true });
  });

  routes.get('/activities', async (c) => {
    const q = listQuerySchema.safeParse(c.req.query());
    if (!q.success)
      return c.json({ error: 'Invalid query', detail: q.error.flatten().fieldErrors }, 400);

    const items = await prisma.activity.findMany({
      where: {
        userId: c.get('userId'),
        ...(q.data.from || q.data.to
          ? {
              startTime: {
                ...(q.data.from ? { gte: new Date(q.data.from) } : {}),
                ...(q.data.to ? { lte: new Date(q.data.to) } : {}),
              },
            }
          : {}),
      },
      orderBy: { startTime: 'desc' },
      take: q.data.limit,
      // cursor semantics: without skip the cursor row itself is re-served
      ...(q.data.cursor ? { cursor: { id: q.data.cursor }, skip: 1 } : {}),
    });

    // which providers delivered each row (for the feed's provider filter);
    // grouped from activity_sources → connection.provider, deduped
    const ids = items.map((a) => a.id);
    const sources = ids.length
      ? await prisma.activitySource.findMany({
          where: { activityId: { in: ids } },
          select: { activityId: true, connection: { select: { provider: true } } },
        })
      : [];
    const providersBy = new Map<string, string[]>();
    for (const s of sources) {
      const list = providersBy.get(s.activityId) ?? [];
      const prov = s.connection.provider;
      if (!list.includes(prov)) list.push(prov);
      providersBy.set(s.activityId, list);
    }

    return c.json({
      items: items.map((a) => ({ ...serializeRow(a), providers: providersBy.get(a.id) ?? [] })),
      nextCursor: items.length === q.data.limit ? (items.at(-1)?.id ?? null) : null,
    });
  });

  // ─── Wellness: nightly sleep + daily wearer metrics ──────────────────────

  const rangeQuerySchema = z.object({
    from: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}/, 'YYYY-MM-DD')
      .optional(),
    to: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}/, 'YYYY-MM-DD')
      .optional(),
    limit: z.coerce.number().int().min(1).max(200).default(60),
  });
  /** dateKey-based rows sorted newest-first; from/to key off date_key, not a
   * timestamp column. */
  async function listDateKeyed(
    table: 'sleepSession' | 'dailyWellness',
    userId: string,
    from: string | undefined,
    to: string | undefined,
    limit: number,
  ) {
    if (table === 'sleepSession') {
      return prisma.sleepSession.findMany({
        where: {
          userId,
          ...(from || to
            ? {
                dateKey: {
                  ...(from ? { gte: from.slice(0, 10) } : {}),
                  ...(to ? { lte: to.slice(0, 10) } : {}),
                },
              }
            : {}),
        },
        orderBy: { dateKey: 'desc' },
        take: limit,
      });
    }
    return prisma.dailyWellness.findMany({
      where: {
        userId,
        ...(from || to
          ? {
              dateKey: {
                ...(from ? { gte: from.slice(0, 10) } : {}),
                ...(to ? { lte: to.slice(0, 10) } : {}),
              },
            }
          : {}),
      },
      orderBy: { dateKey: 'desc' },
      take: limit,
    });
  }

  routes.get('/sleeps', async (c) => {
    const q = rangeQuerySchema.safeParse(c.req.query());
    if (!q.success)
      return c.json({ error: 'Invalid query', detail: q.error.flatten().fieldErrors }, 400);
    const items = await listDateKeyed(
      'sleepSession',
      c.get('userId'),
      q.data.from,
      q.data.to,
      q.data.limit,
    );
    return c.json({ items: items.map(serializeRow) });
  });

  routes.get('/wellness', async (c) => {
    const q = rangeQuerySchema.safeParse(c.req.query());
    if (!q.success)
      return c.json({ error: 'Invalid query', detail: q.error.flatten().fieldErrors }, 400);
    const items = await listDateKeyed(
      'dailyWellness',
      c.get('userId'),
      q.data.from,
      q.data.to,
      q.data.limit,
    );
    return c.json({ items: items.map(serializeRow) });
  });

  routes.get('/activities/:id', async (c) => {
    const id = c.req.param('id');
    const activity = await prisma.activity.findFirst({
      where: { id, userId: c.get('userId') },
    });
    if (!activity) return c.json({ error: 'Not found' }, 404);
    const points = await prisma.activityDataPoint.findMany({
      where: { activityId: id },
      select: { provider: true, sampleCount: true, series: true },
    });
    return c.json({ items: [{ ...serializeRow(activity), series: points }] });
  });

  routes.get('/measurements', async (c) => {
    const q = listQuerySchema.safeParse(c.req.query());
    if (!q.success)
      return c.json({ error: 'Invalid query', detail: q.error.flatten().fieldErrors }, 400);

    const items = await prisma.measurement.findMany({
      where: {
        userId: c.get('userId'),
        ...(q.data.from || q.data.to
          ? {
              measuredAt: {
                ...(q.data.from ? { gte: new Date(q.data.from) } : {}),
                ...(q.data.to ? { lte: new Date(q.data.to) } : {}),
              },
            }
          : {}),
      },
      orderBy: { measuredAt: 'desc' },
      take: q.data.limit,
      // cursor semantics: without skip the cursor row itself is re-served
      ...(q.data.cursor ? { cursor: { id: q.data.cursor }, skip: 1 } : {}),
    });

    return c.json({
      items: items.map((m) => serializeRow(m)),
      nextCursor: items.length === q.data.limit ? (items.at(-1)?.id ?? null) : null,
    });
  });

  // ─── Gear (provider-synced gear + Stridash-managed components) ─────────────

  /** Usage aggregation for one gear: activities linked to it, with the
   * component's install/retire window applied. Called per gear (small N). */
  function usageOf(
    activities: { distanceM: unknown; durationS: number; startTime: Date }[],
    from: Date | null,
    to: Date | null,
  ): { distanceM: number; durationS: number; count: number } {
    let distanceM = 0;
    let durationS = 0;
    let count = 0;
    for (const a of activities) {
      if (from && a.startTime < from) continue;
      if (to && a.startTime > to) continue;
      count++;
      durationS += a.durationS;
      const d = a.distanceM as { toFixed?: unknown } | null;
      distanceM += typeof d === 'number' ? d : Number(d ?? 0);
    }
    return { distanceM, durationS, count };
  }

  routes.get('/gear', async (c) => {
    const userId = c.get('userId');
    const gear = await prisma.gear.findMany({
      where: { userId },
      orderBy: [{ retiredAt: 'asc' }, { createdAt: 'desc' }],
      include: {
        activities: { select: { distanceM: true, durationS: true, startTime: true } },
        components: true,
      },
    });
    return c.json({
      items: gear.map((g) => {
        const components: Array<
          Record<string, unknown> & {
            usage: { distanceM: number; durationS: number; count: number };
          }
        > = g.components.map((comp) => ({
          ...serializeRow(comp),
          usage: usageOf(
            g.activities,
            comp.installedAt ? new Date(comp.installedAt.getTime()) : null,
            comp.retiredAt ? new Date(comp.retiredAt.getTime()) : null,
          ),
        }));
        // mounted components first, then newest
        components.sort(
          (a, b) =>
            Number(a.retiredAt != null) - Number(b.retiredAt != null) ||
            String(b.createdAt).localeCompare(String(a.createdAt)),
        );
        return {
          ...serializeRow({ ...g, activities: undefined, components: undefined }),
          usage: usageOf(g.activities, null, null),
          components,
        };
      }),
    });
  });

  const componentCreateSchema = z.object({
    name: z.string().min(1).max(120),
    kind: z
      .enum([
        'CHAIN',
        'CASSETTE',
        'CHAINRING',
        'BRAKE_PADS',
        'TIRES',
        'TUBES',
        'PEDALS',
        'BATTERY',
        'OTHER',
      ])
      .default('OTHER'),
    installedAt: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}/, 'YYYY-MM-DD')
      .optional(),
    thresholdM: z.number().positive().optional(),
    notes: z.string().max(2000).optional(),
  });

  routes.post('/gear/:gearId/components', async (c) => {
    const parsed = componentCreateSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json({ error: 'Invalid body', detail: parsed.error.flatten().fieldErrors }, 400);
    const gear = await prisma.gear.findFirst({
      where: { id: c.req.param('gearId'), userId: c.get('userId') },
      select: { id: true },
    });
    if (!gear) return c.json({ error: 'Not found' }, 404);
    const created = await prisma.gearComponent.create({
      data: {
        userId: c.get('userId'),
        gearId: gear.id,
        name: parsed.data.name,
        kind: parsed.data.kind,
        installedAt: parsed.data.installedAt
          ? new Date(`${parsed.data.installedAt}T00:00:00Z`)
          : null,
        thresholdM: parsed.data.thresholdM ?? null,
        notes: parsed.data.notes ?? null,
      },
    });
    return c.json({ item: serializeRow(created) }, 201);
  });

  const componentPatchSchema = z.object({
    name: z.string().min(1).max(120).optional(),
    kind: z
      .enum([
        'CHAIN',
        'CASSETTE',
        'CHAINRING',
        'BRAKE_PADS',
        'TIRES',
        'TUBES',
        'PEDALS',
        'BATTERY',
        'OTHER',
      ])
      .optional(),
    installedAt: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}/, 'YYYY-MM-DD')
      .optional(),
    retiredAt: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}/, 'YYYY-MM-DD')
      .nullable()
      .optional(),
    thresholdM: z.number().positive().nullable().optional(),
    notes: z.string().max(2000).nullable().optional(),
  });

  routes.patch('/gear/components/:componentId', async (c) => {
    const parsed = componentPatchSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json({ error: 'Invalid body', detail: parsed.error.flatten().fieldErrors }, 400);
    const component = await prisma.gearComponent.findFirst({
      where: { id: c.req.param('componentId'), userId: c.get('userId') },
      select: { id: true },
    });
    if (!component) return c.json({ error: 'Not found' }, 404);
    const d = parsed.data;
    const updated = await prisma.gearComponent.update({
      where: { id: component.id },
      data: {
        ...(d.name !== undefined ? { name: d.name } : {}),
        ...(d.kind !== undefined ? { kind: d.kind } : {}),
        ...(d.installedAt !== undefined
          ? { installedAt: d.installedAt ? new Date(`${d.installedAt}T00:00:00Z`) : null }
          : {}),
        ...(d.retiredAt !== undefined
          ? { retiredAt: d.retiredAt ? new Date(`${d.retiredAt}T00:00:00Z`) : null }
          : {}),
        ...(d.thresholdM !== undefined ? { thresholdM: d.thresholdM } : {}),
        ...(d.notes !== undefined ? { notes: d.notes } : {}),
      },
    });
    return c.json({ item: serializeRow(updated) });
  });

  routes.delete('/gear/components/:componentId', async (c) => {
    const component = await prisma.gearComponent.findFirst({
      where: { id: c.req.param('componentId'), userId: c.get('userId') },
      select: { id: true },
    });
    if (!component) return c.json({ error: 'Not found' }, 404);
    await prisma.gearComponent.delete({ where: { id: component.id } });
    return c.json({ ok: true });
  });

  return routes;
}
