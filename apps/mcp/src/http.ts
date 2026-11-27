import { createServer } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpServer } from './server.js';
import { configFromEnv, createStridashClient, type StridashMcpConfig } from './client.js';

export interface HttpOptions {
  host?: string;
  port?: number;
  /** Optional bearer token clients must present to reach /mcp. */
  token?: string;
}

/**
 * Stateless Streamable HTTP transport: one MCP server instance per request.
 * Bind to localhost by default; use MCP_HTTP_TOKEN (and a reverse proxy/TLS)
 * before exposing this remotely.
 */
export function startHttpServer(
  config: StridashMcpConfig,
  opts: HttpOptions = {},
): Promise<{ port: number; close: () => Promise<void> }> {
  const host = opts.host ?? process.env.MCP_HTTP_HOST ?? '127.0.0.1';
  const port = opts.port ?? Number(process.env.MCP_HTTP_PORT ?? 3100);
  const authToken = opts.token ?? process.env.MCP_HTTP_TOKEN;
  const client = createStridashClient(config);

  const httpServer = createServer((req, res) => {
    void (async () => {
      if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
        return;
      }
      if (req.url !== '/mcp') {
        res.writeHead(404).end('Not found');
        return;
      }
      if (authToken && req.headers.authorization !== `Bearer ${authToken}`) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }
      if (req.method !== 'POST') {
        res.writeHead(405, { allow: 'POST' }).end('Use POST /mcp');
        return;
      }

      const server = createMcpServer(client);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => {
        void transport.close().catch(() => undefined);
        void server.close().catch(() => undefined);
      });
      try {
        await server.connect(transport);
        await transport.handleRequest(req, res);
      } catch (err) {
        console.error('[stridash-mcp] HTTP request failed:', err);
        if (!res.headersSent) res.writeHead(500).end('Internal error');
      }
    })();
  });

  return new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, host, () => {
      const address = httpServer.address();
      const actualPort = typeof address === 'object' && address ? address.port : port;
      resolve({
        port: actualPort,
        close: () =>
          new Promise<void>((done, fail) => httpServer.close((err) => (err ? fail(err) : done()))),
      });
    });
  });
}

export async function runHttpFromEnv(): Promise<void> {
  const config = configFromEnv();
  const started = await startHttpServer(config);
  console.log(
    `[stridash-mcp] Streamable HTTP listening on http://${process.env.MCP_HTTP_HOST ?? '127.0.0.1'}:${started.port}/mcp`,
  );
}
