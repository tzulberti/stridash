import { afterEach, describe, expect, it } from 'vitest';
import { startHttpServer } from './http.js';
import type { StridashMcpConfig } from './client.js';

const config: StridashMcpConfig = {
  apiUrl: 'http://127.0.0.1:9',
  token: 'sdat_test',
};

const started: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  while (started.length) await started.pop()!.close();
});

async function listen(token?: string) {
  const server = await startHttpServer(config, { port: 0, token });
  started.push(server);
  return server;
}

describe('Streamable HTTP transport', () => {
  it('serves health, rejects unauthenticated MCP calls and accepts initialize', async () => {
    const server = await listen('secret');
    const base = `http://127.0.0.1:${server.port}`;

    expect((await fetch(`${base}/health`)).status).toBe(200);

    expect(
      (
        await fetch(`${base}/mcp`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        })
      ).status,
    ).toBe(401);

    const init = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer secret',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'test', version: '1' },
        },
      }),
    });
    expect(init.status).toBe(200);
    expect(init.headers.get('content-type')).toMatch(/application\/json|text\/event-stream/);
  });

  it('rejects non-MCP paths and non-POST methods', async () => {
    const server = await listen();
    const base = `http://127.0.0.1:${server.port}`;
    expect((await fetch(`${base}/nope`)).status).toBe(404);
    expect((await fetch(`${base}/mcp`)).status).toBe(405);
  });
});
