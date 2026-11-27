/** Expo push notifications for “new activity synced” events. */

import { prisma } from '../db.js';
import { safeErrorForLog } from '../redact.js';

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
const CHUNK = 100;

export async function sendPushToUser(
  userId: string,
  title: string,
  body: string,
  data?: Record<string, unknown>,
): Promise<number> {
  const rows = await prisma.pushToken.findMany({
    where: { userId },
    select: { token: true },
  });
  if (rows.length === 0) return 0;

  let sent = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const messages = chunk.map((row) => ({
      to: row.token,
      sound: 'default',
      title,
      body,
      ...(data ? { data } : {}),
    }));
    let res: Response;
    try {
      res = await fetch(EXPO_PUSH_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(messages),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      throw new Error(`Expo push unreachable: ${err instanceof Error ? err.message : String(err)}`);
    }
    const json = (await res.json().catch(() => null)) as {
      data?: Array<{ status?: string; details?: { error?: string } }>;
    } | null;
    if (!res.ok) throw new Error(`Expo push failed (HTTP ${res.status})`);

    // Prune tokens Expo reports as permanently invalid.
    const invalid: string[] = [];
    (json?.data ?? []).forEach((ticket, index) => {
      if (
        ticket.status === 'error' &&
        ticket.details?.error === 'DeviceNotRegistered' &&
        chunk[index]
      ) {
        invalid.push(chunk[index]!.token);
      }
    });
    if (invalid.length) {
      await prisma.pushToken.deleteMany({ where: { token: { in: invalid } } }).catch((err) => {
        console.error('[push] failed to prune invalid tokens:', safeErrorForLog(err));
      });
    }
    sent += chunk.length;
  }
  return sent;
}

/** Fire-and-forget notification after a sync that created activities. */
export async function notifyNewActivities(userId: string, created: number): Promise<void> {
  if (created <= 0) return;
  await sendPushToUser(
    userId,
    'Stridash',
    `${created} new ${created === 1 ? 'activity' : 'activities'} synced`,
    { type: 'new-activities', count: String(created) },
  );
}
