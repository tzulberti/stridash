/**
 * Device registry: the physical hardware that records activities. Rows are
 * deduped per (user, provider, source_device_id) — the FIT device message's
 * serial number. Model names are resolved by the provider when it can
 * (Garmin's device-registration endpoint) and filled in lazily otherwise.
 */
import { Prisma } from '../generated/prisma/client.js';
import { prisma } from '../db.js';

export interface DeviceUpsertInput {
  provider: 'GARMIN' | 'IGPSPORT';
  /// serial number / provider device id as a string — the dedup key
  sourceDeviceId: string;
  manufacturer?: string | null;
  /// friendly display name ("Forerunner 955 Solar"), when resolvable
  model?: string | null;
  productCode?: number | null;
  softwareVersion?: string | null;
  hardwareVersion?: string | null;
  /// the provider payload as-received (raw payload is the authority)
  raw: unknown;
}

/** Upsert a device row and return its id. Later observations fill the
 * gaps: an unresolved model name gets set the first time a sync can name
 * it, and the latest firmware version wins. */
export async function upsertDevice(userId: string, input: DeviceUpsertInput): Promise<string> {
  const data = {
    manufacturer: input.manufacturer ?? null,
    model: input.model ?? null,
    productCode: input.productCode ?? null,
    softwareVersion: input.softwareVersion ?? null,
    hardwareVersion: input.hardwareVersion ?? null,
    raw: (input.raw ?? Prisma.DbNull) as never,
  };
  const existing = await prisma.device.findUnique({
    where: {
      userId_provider_sourceDeviceId: {
        userId,
        provider: input.provider,
        sourceDeviceId: input.sourceDeviceId,
      },
    },
    select: { id: true },
  });
  if (!existing) {
    const created = await prisma.device.create({
      data: {
        userId,
        provider: input.provider,
        sourceDeviceId: input.sourceDeviceId,
        ...data,
      },
      select: { id: true },
    });
    return created.id;
  }
  // fill gaps only: never overwrite a resolved name with null, and keep the
  // newest firmware string (later observation wins on the scalar columns)
  const update: Record<string, unknown> = { raw: data.raw };
  for (const key of [
    'manufacturer',
    'model',
    'productCode',
    'softwareVersion',
    'hardwareVersion',
  ] as const) {
    if (data[key] !== null) update[key] = data[key];
  }
  await prisma.device.update({ where: { id: existing.id }, data: update as never });
  return existing.id;
}
