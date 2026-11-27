import { Hono } from 'hono';
import { z } from 'zod';
import { Prisma } from '../generated/prisma/client.js';
import { prisma } from '../db.js';
import { requireUserId } from '../auth.js';
import type { Env } from '../env.js';
import { safeErrorForLog } from '../redact.js';
import { exportFilename, exportWebStream } from '../services/account-export.js';
import { CSV_KINDS, csvFilename, csvWebStream, type CsvKind } from '../services/csv-export.js';
import { resyncGarminActivity } from '../services/garmin-sync.js';
import { resyncIgpSportActivity } from '../services/igpsport-sync.js';
import { resyncZwiftActivity } from '../services/zwift-sync.js';
import { serializeRow } from '../serialize.js';
import { uuidParam } from '../params.js';
import { createApiToken, listApiTokens, revokeApiToken } from '../services/api-tokens.js';

const listQuerySchema = z.object({
  /** ISO date lower bound (activities.start_time / measurements.measured_at) */
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().uuid().optional(),
});

const apiTokenCreateSchema = z.object({
  name: z.string().min(1).max(80),
  /** Optional lifetime; omitted = non-expiring until revoked. */
  expiresInDays: z.number().int().min(1).max(3650).optional(),
});

const pushTokenSchema = z.object({
  token: z
    .string()
    .min(10)
    .max(512)
    .regex(/^(ExponentPushToken|ExpoPushToken)\[.+\]$/, 'Must be an Expo push token'),
  platform: z.enum(['ios', 'android', 'web']),
});

const manualMeasurementSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('WEIGH_IN'),
    measuredAt: z.string().datetime().optional(),
    weightKg: z.number().positive().max(500),
    bodyFatPct: z.number().min(0).max(80).optional(),
    muscleMassKg: z.number().positive().max(300).optional(),
    skeletalMusclePct: z.number().min(0).max(100).optional(),
    bmi: z.number().positive().max(100).optional(),
    visceralFatLevel: z.number().min(0).max(60).optional(),
    notes: z.string().max(1000).optional(),
  }),
  z.object({
    kind: z.literal('BLOOD_PRESSURE'),
    measuredAt: z.string().datetime().optional(),
    systolicMmhg: z.number().int().min(70).max(260),
    diastolicMmhg: z.number().int().min(40).max(150),
    pulseBpm: z.number().int().min(20).max(250).optional(),
    notes: z.string().max(1000).optional(),
  }),
]);

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: string }).code === 'P2002'
  );
}

/** Feed rows: scalars the list actually renders. Raw/detail payloads, notes
 * and HR-zone arrays live only on `/activities/:id` (D6). */
const feedActivitySelect = {
  id: true,
  userId: true,
  headline: true,
  workoutName: true,
  type: true,
  startTime: true,
  durationS: true,
  movingTimeS: true,
  distanceM: true,
  avgSpeedMs: true,
  maxSpeedMs: true,
  totalAscentM: true,
  totalDescentM: true,
  elevationHighM: true,
  elevationLowM: true,
  avgHr: true,
  maxHr: true,
  avgPowerW: true,
  maxPowerW: true,
  avgCadence: true,
  maxCadence: true,
  caloriesKcal: true,
  trainingLoad: true,
  sweatLossMl: true,
  aerobicTe: true,
  anaerobicTe: true,
  aerobicTeMessage: true,
  anaerobicTeMessage: true,
  vo2max: true,
  recoveryMinutes: true,
  normalizedPowerW: true,
  indoor: true,
  gearId: true,
  deviceId: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.ActivitySelect;

export function dataRoutes(env: Env): Hono<{ Variables: { userId: string } }> {
  const routes = new Hono<{ Variables: { userId: string } }>();

  routes.use('*', async (c, next) => {
    c.set('userId', await requireUserId(c, env.STRIDASH_JWT_SECRET));
    await next();
  });

  routes.get('/me', async (c) => {
    const userId = c.get('userId');
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { email: true, displayName: true, createdAt: true, preferences: true },
    });
    if (!user) return c.json({ error: 'Not found' }, 404);
    // per-provider chart configuration (rows only exist where the user
    // customized; absent provider = canonical order, all channels visible)
    const chartPrefs = await prisma.chartChannelPref.findMany({
      where: { userId },
      orderBy: [{ provider: 'asc' }, { position: 'asc' }],
    });
    const chartChannels: Record<string, Array<{ key: string; visible: boolean }>> = {};
    for (const pref of chartPrefs) {
      (chartChannels[pref.provider] ??= []).push({ key: pref.channel, visible: pref.visible });
    }
    // a user without a preferences row (pre-migration edge) reads as defaults
    const { preferences, ...account } = user;
    return c.json({
      ...account,
      createdAt: user.createdAt.toISOString(),
      preferences: {
        units: preferences?.units ?? 'km',
        theme: preferences?.theme ?? 'dark',
        language: preferences?.language ?? 'en',
        chartChannels,
      },
    });
  });

  /** Save account preferences — a typed column per setting on
   * user_preferences (no jsonb). Partial updates; unknown keys are 400s. */
  const preferencesSchema = z.object({
    units: z.enum(['km', 'mi']).optional(),
    theme: z.enum(['dark', 'light']).optional(),
    language: z
      .enum(['en', 'es', 'pt', 'fr', 'de', 'it', 'nl', 'ru', 'ja', 'ko', 'zh', 'hi'])
      .optional(),
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
      return c.json({
        preferences: {
          units: preferences.units,
          theme: preferences.theme,
          language: preferences.language,
        },
      });
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

  /**
   * Chart configuration for the activity page (the Settings tab's per-
   * provider chart lists): for one provider, the FULL ordered channel list
   * with a visible flag each — array order is display order, and hidden
   * channels keep their slot so re-showing them doesn't reshuffle the
   * layout. The body replaces that provider's rows wholesale; a provider
   * left untouched (or emptied) falls back to "every channel visible, in
   * the app's canonical order". Providers are the series-bearing ones —
   * OMRON stores measurements and MANUAL rows carry no series.
   */
  const chartChannelsSchema = z.object({
    channels: z
      .array(
        z.object({
          key: z.enum([
            'speedMs',
            'hrBpm',
            'powerW',
            'cadenceRpm',
            'altitudeM',
            'temperatureC',
            'respirationRate',
            'staminaPct',
            'stepLengthM',
            'verticalOscillationM',
            'stanceTimePct',
            'verticalRatioPct',
          ]),
          visible: z.boolean(),
        }),
      )
      .max(32),
  });
  const CHART_PROVIDERS = ['GARMIN', 'ZWIFT', 'IGPSPORT', 'STRAVA'] as const;

  routes.put('/preferences/charts/:provider', async (c) => {
    const provider = c.req.param('provider');
    if (!CHART_PROVIDERS.includes(provider as (typeof CHART_PROVIDERS)[number])) {
      return c.json({ error: 'Unknown provider' }, 404);
    }
    const parsed = chartChannelsSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json({ error: 'Invalid body', detail: parsed.error.flatten().fieldErrors }, 400);
    const keys = parsed.data.channels.map((ch) => ch.key);
    if (new Set(keys).size !== keys.length) {
      return c.json({ error: 'Duplicate channel' }, 400);
    }

    const userId = c.get('userId');
    await prisma.$transaction([
      prisma.chartChannelPref.deleteMany({ where: { userId, provider: provider as never } }),
      prisma.chartChannelPref.createMany({
        data: parsed.data.channels.map((ch, position) => ({
          userId,
          provider: provider as never,
          channel: ch.key,
          position,
          visible: ch.visible,
        })),
      }),
    ]);
    return c.json({ chartChannels: { [provider]: parsed.data.channels } });
  });

  // ─── Account data: full export + hard delete ───────────────────────────────

  /** CSV exports (activities / measurements / sleep / wellness) — streaming,
   * one flat table per request so it opens directly in a spreadsheet. */
  routes.get('/export/csv', (c) => {
    const kind = c.req.query('type') as CsvKind | undefined;
    if (!kind || !CSV_KINDS.includes(kind)) {
      return c.json({ error: `type must be one of: ${CSV_KINDS.join(', ')}` }, 400);
    }
    return new Response(csvWebStream(c.get('userId'), kind), {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${csvFilename(kind)}"`,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  });

  /** Full JSON dump of everything this user's account holds ("raw payload is
   * the authority" — activities carry their raw/detail payloads as-received).
   * The response is streamed row-by-row via cursor pagination, including the
   * per-sample `activityDataPoints` series; peak memory is one page, not the
   * account's whole history. Tokens/secrets are never selected. */
  routes.get('/export', (c) => {
    return new Response(exportWebStream(c.get('userId')), {
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="${exportFilename()}"`,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  });

  /** Hard delete: the user row cascades to connections, activities,
   * measurements, sleep, wellness, gear, components and refresh tokens
   * (every FK from users is ON DELETE CASCADE). Irreversible. */
  routes.delete('/me', async (c) => {
    try {
      await prisma.user.delete({ where: { id: c.get('userId') } });
    } catch (err) {
      // A stale token can reach this after the account is already gone.
      if (
        typeof err === 'object' &&
        err !== null &&
        'code' in err &&
        (err as { code?: string }).code === 'P2025'
      ) {
        return c.json({ error: 'Not found' }, 404);
      }
      throw err;
    }
    return c.json({ ok: true });
  });

  // ─── API tokens (MCP/automation, long-lived) ──────────────────────────────

  routes.get('/tokens', async (c) => {
    const items = await listApiTokens(c.get('userId'));
    return c.json({ items, nextCursor: null });
  });

  routes.post('/tokens', async (c) => {
    const body = apiTokenCreateSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) {
      return c.json({ error: 'Invalid request', detail: body.error.flatten().fieldErrors }, 400);
    }
    const active = await prisma.apiToken.count({
      where: {
        userId: c.get('userId'),
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
    });
    if (active >= env.STRIDASH_MAX_API_TOKENS) {
      return c.json(
        {
          error: `API token limit reached (${env.STRIDASH_MAX_API_TOKENS}) — revoke an old token first`,
        },
        409,
      );
    }
    const expiresAt = body.data.expiresInDays
      ? new Date(Date.now() + body.data.expiresInDays * 86_400_000)
      : null;
    const created = await createApiToken(c.get('userId'), body.data.name.trim(), expiresAt);
    return c.json({ token: created.token, ...created.item }, 201);
  });

  routes.delete('/tokens/:id', async (c) => {
    const id = uuidParam(c);
    if (!id) return c.json({ error: 'Invalid token id' }, 400);
    const revoked = await revokeApiToken(c.get('userId'), id);
    if (!revoked) return c.json({ error: 'Not found' }, 404);
    return c.json({ ok: true });
  });

  // ─── Push tokens (mobile "new activity synced") ───────────────────────────

  routes.post('/push-tokens', async (c) => {
    const body = pushTokenSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) {
      return c.json({ error: 'Invalid request', detail: body.error.flatten().fieldErrors }, 400);
    }
    const row = await prisma.pushToken.upsert({
      where: { token: body.data.token },
      create: {
        userId: c.get('userId'),
        token: body.data.token,
        platform: body.data.platform,
      },
      update: {
        userId: c.get('userId'),
        platform: body.data.platform,
        lastSeenAt: new Date(),
      },
      select: { id: true, token: true, platform: true, createdAt: true, lastSeenAt: true },
    });
    return c.json(row, 201);
  });

  routes.delete('/push-tokens', async (c) => {
    const body = await c.req.json().catch(() => null);
    if (typeof body?.token !== 'string') return c.json({ error: 'Invalid request' }, 400);
    await prisma.pushToken.deleteMany({
      where: { userId: c.get('userId'), token: body.token },
    });
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
      select: feedActivitySelect,
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
    const id = uuidParam(c);
    if (!id) return c.json({ error: 'Invalid activity id' }, 400);
    const activity = await prisma.activity.findFirst({
      where: { id, userId: c.get('userId') },
      include: {
        device: true,
        sources: { select: { connection: { select: { provider: true } } } },
      },
    });
    if (!activity) return c.json({ error: 'Not found' }, 404);
    const points = await prisma.activityDataPoint.findMany({
      where: { activityId: id },
      select: { provider: true, sampleCount: true, series: true },
    });
    // device flattened to the display fields (+ raw as-received)
    const { device, sources, ...row } = activity;
    return c.json({
      items: [
        {
          ...serializeRow(row),
          // which providers delivered this row (list rows carry the same
          // field) — the detail page uses it for the re-sync action
          providers: [...new Set(sources.map((s) => s.connection.provider))],
          device: device ? serializeRow(device) : null,
          series: points,
        },
      ],
    });
  });

  /**
   * Force re-sync of ONE activity from the provider that owns it (the web
   * detail page's "Re-sync" action). The owning provider is the one whose
   * payload built this row (`raw.provider`) — provenance-only sources from
   * other providers must never rewrite the owner's authoritative scalars.
   * 404 for foreign/unknown rows, 409 when no ACTIVE connection provides it,
   * 501 for providers without a sync path (STRAVA), 200 with per-provider
   * outcomes otherwise (a provider failure is reported, not thrown).
   */
  routes.post('/activities/:id/resync', async (c) => {
    const id = uuidParam(c);
    if (!id) return c.json({ error: 'Invalid activity id' }, 400);
    const activity = await prisma.activity.findFirst({
      where: { id, userId: c.get('userId') },
      select: {
        id: true,
        raw: true,
        sources: {
          select: {
            sourceActivityId: true,
            connection: {
              select: { id: true, userId: true, provider: true, status: true },
            },
          },
        },
      },
    });
    if (!activity) return c.json({ error: 'Not found' }, 404);

    const owner = (activity.raw as Record<string, unknown> | null)?.provider;
    const supportable = activity.sources.filter(
      (s) => s.connection.status === 'ACTIVE' && String(owner ?? '') === s.connection.provider,
    );
    if (!supportable.length) {
      return c.json(
        {
          error: owner
            ? `No active ${owner} connection provides this activity`
            : 'No active connection provides this activity',
        },
        409,
      );
    }
    if (supportable.some((s) => !['GARMIN', 'ZWIFT', 'IGPSPORT'].includes(s.connection.provider))) {
      return c.json({ error: 'Provider does not support sync yet' }, 501);
    }

    // full rows — the token-refreshing resyncers need the credential columns
    const connections = await prisma.connection.findMany({
      where: { id: { in: supportable.map((s) => s.connection.id) } },
    });
    const connById = new Map(connections.map((conn) => [conn.id, conn]));

    const results: Array<{ provider: string; status: 'ok' | 'error'; error?: string }> = [];
    for (const s of supportable) {
      const conn = connById.get(s.connection.id);
      if (!conn) continue; // connection vanished mid-request — next sync catches it
      try {
        if (s.connection.provider === 'GARMIN') {
          await resyncGarminActivity(env, conn, activity.id, s.sourceActivityId);
        } else if (s.connection.provider === 'ZWIFT') {
          await resyncZwiftActivity(env, conn, activity.id, s.sourceActivityId);
        } else {
          await resyncIgpSportActivity(env, conn, activity.id, s.sourceActivityId);
        }
        results.push({ provider: s.connection.provider, status: 'ok' });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(
          `[resync] ${s.connection.provider} ${s.sourceActivityId} failed:`,
          safeErrorForLog(err),
        );
        results.push({ provider: s.connection.provider, status: 'error', error: message });
      }
    }
    return c.json({ results });
  });

  /** Candidate activities worth comparing the base one against: same type
   * and roughly the same size — distance within ±25%, or duration within
   * ±40% when the base carries no distance (WORKOUT/OTHER rows). Newest
   * first; provider-lean rows (picker needs headline/date/distance/time). */
  routes.get('/activities/:id/similar', async (c) => {
    const id = uuidParam(c);
    if (!id) return c.json({ error: 'Invalid activity id' }, 400);
    const base = await prisma.activity.findFirst({
      where: { id, userId: c.get('userId') },
      select: { id: true, type: true, distanceM: true, durationS: true },
    });
    if (!base) return c.json({ error: 'Not found' }, 404);
    const baseDistance = base.distanceM == null ? null : Number(base.distanceM);
    const where: Prisma.ActivityWhereInput = {
      userId: c.get('userId'),
      type: base.type,
      id: { not: base.id },
      ...(baseDistance != null
        ? { distanceM: { gte: baseDistance * 0.75, lte: baseDistance * 1.25 } }
        : base.durationS != null
          ? {
              durationS: {
                gte: Math.round(base.durationS * 0.6),
                lte: Math.round(base.durationS * 1.67),
              },
            }
          : {}),
    };
    const items = await prisma.activity.findMany({
      where,
      orderBy: { startTime: 'desc' },
      take: 20,
      select: {
        id: true,
        headline: true,
        type: true,
        startTime: true,
        durationS: true,
        movingTimeS: true,
        distanceM: true,
        avgSpeedMs: true,
      },
    });
    return c.json({ items: items.map(serializeRow) });
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

  /** Manual weigh-in / blood-pressure quick-add (M5). Provider MANUAL, no
   * connection; the same user+provider+kind+measuredAt unique key prevents
   * accidental double-submits. */
  routes.post('/measurements', async (c) => {
    const parsed = manualMeasurementSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: 'Invalid request', detail: parsed.error.flatten().fieldErrors }, 400);
    }
    const body = parsed.data;
    const measuredAt = body.measuredAt ? new Date(body.measuredAt) : new Date();
    const { kind, measuredAt: _ignored, notes, ...fields } = body;
    try {
      const row = await prisma.measurement.create({
        data: {
          userId: c.get('userId'),
          provider: 'MANUAL',
          kind,
          measuredAt,
          notes: notes?.trim() || null,
          ...fields,
          raw: { provider: 'MANUAL' },
        },
      });
      return c.json(serializeRow(row), 201);
    } catch (err) {
      if (isUniqueViolation(err)) {
        return c.json({ error: 'A measurement already exists at that time' }, 409);
      }
      throw err;
    }
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
