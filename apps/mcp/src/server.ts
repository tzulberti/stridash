import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ListQuery, StridashClient } from './client.js';

const listSchema = {
  from: z.string().datetime().optional().describe('ISO lower bound'),
  to: z.string().datetime().optional().describe('ISO upper bound'),
  limit: z.number().int().min(1).max(100).optional().describe('Maximum rows'),
};

function textResult(value: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
  };
}

function errorResult(err: unknown) {
  return {
    isError: true,
    content: [
      {
        type: 'text' as const,
        text: `Stridash error: ${err instanceof Error ? err.message : String(err)}`,
      },
    ],
  };
}

export function registerTools(server: McpServer, client: StridashClient): void {
  server.registerTool(
    'search_activities',
    {
      title: 'Search activities',
      description: 'List synced activities, newest first. Filter with from/to ISO timestamps.',
      inputSchema: listSchema,
    },
    async (args) => {
      try {
        return textResult(await client.searchActivities(args as ListQuery));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'get_activity',
    {
      title: 'Get activity',
      description: 'Full activity detail including providers, device and per-provider series.',
      inputSchema: { id: z.string().uuid() },
    },
    async ({ id }) => {
      try {
        return textResult(await client.getActivity(id));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'similar_activities',
    {
      title: 'Similar activities',
      description: 'Same-type activities near this one (distance/duration band) for comparison.',
      inputSchema: { id: z.string().uuid() },
    },
    async ({ id }) => {
      try {
        return textResult(await client.getSimilarActivities(id));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'get_measurements',
    {
      title: 'Weigh-ins and blood pressure',
      description: 'Measurement rows (weight/body composition and blood pressure), newest first.',
      inputSchema: listSchema,
    },
    async (args) => {
      try {
        return textResult(await client.getMeasurements(args as ListQuery));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'get_sleep',
    {
      title: 'Sleep sessions',
      description: 'Nightly sleep stages, score, HRV and body-battery change.',
      inputSchema: listSchema,
    },
    async (args) => {
      try {
        return textResult(await client.getSleeps(args as ListQuery));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'get_daily_wellness',
    {
      title: 'Daily wellness',
      description: 'Steps, floors, calories, resting HR, stress and body battery by day.',
      inputSchema: listSchema,
    },
    async (args) => {
      try {
        return textResult(await client.getWellness(args as ListQuery));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'get_gear',
    {
      title: 'Gear wear',
      description: 'Bikes/shoes with provider usage, thresholds and Stridash components.',
      inputSchema: {},
    },
    async () => {
      try {
        return textResult(await client.getGear());
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'get_connections',
    {
      title: 'Provider connections',
      description: 'Connected providers, status and last-sync time (tokens never exposed).',
      inputSchema: {},
    },
    async () => {
      try {
        return textResult(await client.getConnections());
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}

export function createMcpServer(client: StridashClient): McpServer {
  const server = new McpServer({ name: 'stridash', version: '0.1.0' });
  registerTools(server, client);
  return server;
}
