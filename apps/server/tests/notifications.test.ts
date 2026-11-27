import { beforeEach, describe, expect, it, vi } from 'vitest';

const { prisma } = vi.hoisted(() => ({
  prisma: {
    pushToken: {
      findMany: vi.fn(),
      deleteMany: vi.fn(async () => ({ count: 0 })),
    },
  },
}));
vi.mock('../src/db.js', () => ({ prisma }));

import { notifyNewActivities, sendPushToUser } from '../src/services/notifications.js';

const fetchMock = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  prisma.pushToken.findMany.mockResolvedValue([]);
  prisma.pushToken.deleteMany.mockResolvedValue({ count: 1 });
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

describe('sendPushToUser', () => {
  it('does nothing without registered tokens', async () => {
    await expect(sendPushToUser('u1', 'Title', 'Body')).resolves.toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends Expo messages and prunes DeviceNotRegistered tokens', async () => {
    prisma.pushToken.findMany.mockResolvedValueOnce([
      { token: 'ExponentPushToken[good]' },
      { token: 'ExponentPushToken[dead]' },
    ]);
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: [{ status: 'ok' }, { status: 'error', details: { error: 'DeviceNotRegistered' } }],
        }),
        { status: 200 },
      ),
    );

    await expect(
      sendPushToUser('u1', 'Stridash', '2 new activities synced', { type: 'new-activities' }),
    ).resolves.toBe(2);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url)).toBe('https://exp.host/--/api/v2/push/send');
    expect(JSON.parse(String(init.body))).toEqual([
      expect.objectContaining({ to: 'ExponentPushToken[good]', title: 'Stridash' }),
      expect.objectContaining({ to: 'ExponentPushToken[dead]' }),
    ]);
    expect(prisma.pushToken.deleteMany).toHaveBeenCalledWith({
      where: { token: { in: ['ExponentPushToken[dead]'] } },
    });
  });

  it('surfaces network and HTTP failures', async () => {
    prisma.pushToken.findMany.mockResolvedValue([{ token: 'ExponentPushToken[x]' }]);
    fetchMock.mockRejectedValueOnce(new TypeError('offline'));
    await expect(sendPushToUser('u1', 't', 'b')).rejects.toThrow('Expo push unreachable');

    fetchMock.mockResolvedValueOnce(new Response('down', { status: 500 }));
    await expect(sendPushToUser('u1', 't', 'b')).rejects.toThrow('HTTP 500');
  });
});

describe('notifyNewActivities', () => {
  it('skips zero/negative counts and formats singular/plural', async () => {
    await notifyNewActivities('u1', 0);
    expect(fetchMock).not.toHaveBeenCalled();

    prisma.pushToken.findMany.mockResolvedValue([{ token: 'ExponentPushToken[x]' }]);
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ data: [{ status: 'ok' }] })));
    await notifyNewActivities('u1', 1);
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1].body)) as Array<{
      body: string;
    }>;
    expect(body[0]?.body).toBe('1 new activity synced');
  });
});
