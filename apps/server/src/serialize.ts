import { Prisma } from './generated/prisma/client.js';

/**
 * Serialization helper for API responses and the account export:
 * Prisma Decimals become JSON numbers, Dates become ISO strings.
 *
 * Use the Decimal class check rather than duck-typing `toFixed`: unrelated
 * objects may expose that method and must not be silently coerced.
 */
export function serializeRow(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(row).map(([k, v]) => {
      if (v instanceof Date) return [k, v.toISOString()];
      if (Prisma.Decimal.isDecimal(v)) return [k, v.toNumber()];
      return [k, v];
    }),
  );
}
