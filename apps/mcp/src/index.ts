import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { configFromEnv, createStridashClient } from './client.js';
import { createMcpServer } from './server.js';
import { runHttpFromEnv } from './http.js';

async function main(): Promise<void> {
  if ((process.env.MCP_TRANSPORT ?? 'stdio') === 'http') {
    await runHttpFromEnv();
    return;
  }
  const config = configFromEnv();
  const server = createMcpServer(createStridashClient(config));
  await server.connect(new StdioServerTransport());
}

main().catch((err) => {
  console.error('[stridash-mcp]', err instanceof Error ? err.message : err);
  process.exit(1);
});
