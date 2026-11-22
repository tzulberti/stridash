/**
 * Serialization helper for API responses and the account export:
 * Prisma Decimals become JSON numbers, Dates become ISO strings.
 *
 * Prisma's Decimal class has `toFixed`, but so do a few unrelated objects;
 * this is deliberately kept in one place so C9 can tighten it later without
 * changing every route.
 */
export function serializeRow(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(row).map(([k, v]) => {
      if (v instanceof Date) return [k, v.toISOString()];
      if (
        typeof v === 'object' &&
        v !== null &&
        'toFixed' in v &&
        typeof (v as { toFixed?: unknown }).toFixed === 'function'
      ) {
        return [k, Number(v)]; // Prisma Decimal
      }
      return [k, v];
    }),
  );
}
