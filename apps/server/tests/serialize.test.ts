import { describe, expect, it } from 'vitest';
import { Prisma } from '../src/generated/prisma/client.js';
import { serializeRow } from '../src/serialize.js';

describe('serializeRow', () => {
  it('converts Prisma Decimals and Dates without touching other values', () => {
    const row = serializeRow({
      weightKg: new Prisma.Decimal('70.25'),
      createdAt: new Date('2026-11-23T10:00:00.000Z'),
      notes: 'morning weigh-in',
      nested: { keep: true },
    });

    expect(row).toEqual({
      weightKg: 70.25,
      createdAt: '2026-11-23T10:00:00.000Z',
      notes: 'morning weigh-in',
      nested: { keep: true },
    });
  });

  it('does not coerce arbitrary objects that happen to expose toFixed', () => {
    const weird = { toFixed: () => 'not-a-decimal' };

    expect(serializeRow({ weird })).toEqual({ weird });
  });
});
