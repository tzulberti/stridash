import { prisma } from '../db.js';
import type { Prisma, Provider } from '../generated/prisma/client.js';

/**
 * Stable connection identity (D4).
 *
 * Provider identity endpoints are best-effort: a transient failure used to
 * store the login (email/username) as `providerUserId`; a later success stored
 * the numeric/athlete id instead, creating a second connection for the same
 * account. We now look for an existing row by the resolved id OR the login
 * saved in `config`, and update that row in place. The advisory lock makes
 * concurrent connect attempts for one provider serialize too.
 */
export interface StableConnectionInput {
  userId: string;
  provider: Provider;
  /** Best-known provider-side identity (may be the login when unresolved). */
  providerUserId: string;
  /** Stable login identifier from the user's input. */
  login: string;
  /** Config object key, e.g. `omron`, `garmin`, `zwift`, `igpsport`. */
  configKey: string;
  /** Login field inside that object, e.g. `identifier`, `email`, `username`. */
  loginField: string;
  create: Omit<Prisma.ConnectionUncheckedCreateInput, 'userId' | 'provider' | 'providerUserId'>;
  update: Prisma.ConnectionUncheckedUpdateInput;
  select: Prisma.ConnectionSelect;
}

interface ExistingConnection {
  id: string;
  providerUserId: string;
  config: unknown;
}

function loginFromConfig(
  config: unknown,
  configKey: string,
  loginField: string,
): string | undefined {
  if (typeof config !== 'object' || config === null) return undefined;
  const group = (config as Record<string, unknown>)[configKey];
  if (typeof group !== 'object' || group === null) return undefined;
  const value = (group as Record<string, unknown>)[loginField];
  return typeof value === 'string' ? value : undefined;
}

function findExisting(
  rows: ExistingConnection[],
  input: Omit<StableConnectionInput, 'select'>,
): ExistingConnection | undefined {
  const byId = rows.find((row) => row.providerUserId === input.providerUserId);
  if (byId) return byId;

  const login = input.login.trim().toLowerCase();
  return rows.find(
    (row) =>
      loginFromConfig(row.config, input.configKey, input.loginField)?.trim().toLowerCase() ===
      login,
  );
}

export async function upsertStableConnection<T extends Prisma.ConnectionSelect>(
  input: Omit<StableConnectionInput, 'select'> & { select: T },
): Promise<Prisma.ConnectionGetPayload<{ select: T }>> {
  return prisma.$transaction(async (tx) => {
    // One connect per (user, provider) at a time — cross-process as well.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`connection:${input.userId}:${input.provider}`}))`;

    const rows = await tx.connection.findMany({
      where: { userId: input.userId, provider: input.provider },
      select: { id: true, providerUserId: true, config: true },
    });
    const existing = findExisting(rows, input);

    if (existing) {
      return tx.connection.update({
        where: { id: existing.id },
        data: { ...input.update, providerUserId: input.providerUserId },
        select: input.select,
      });
    }

    return tx.connection.create({
      data: {
        ...input.create,
        userId: input.userId,
        provider: input.provider,
        providerUserId: input.providerUserId,
      },
      select: input.select,
    });
  });
}
