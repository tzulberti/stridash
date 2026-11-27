# MCP server

`apps/mcp` is a read-only Model Context Protocol server for LLM clients. It
talks to the Stridash REST API using a long-lived API token, so the same
authorization/ownership rules apply as for any other client.

## Setup

1. Create an API token in Stridash (browser JWT required):

   ```bash
   curl -s http://localhost:3000/api/tokens \
     -H "Authorization: Bearer $STRIDASH_JWT" \
     -H 'content-type: application/json' \
     -d '{"name":"MCP"}'
   ```

   Copy the returned `sdat_…` value; it is shown once.

2. Run the server:

   ```bash
   STRIDASH_API_URL=http://localhost:3000 \
   STRIDASH_API_TOKEN=sdat_… \
   npm run start -w @stridash/mcp
   ```

   Or from the repo root: `npm run mcp`.

3. Point an MCP client at the stdio process, e.g.:

   ```json
   {
     "mcpServers": {
       "stridash": {
         "command": "npm",
         "args": ["run", "start", "-w", "@stridash/mcp"],
         "env": {
           "STRIDASH_API_URL": "http://localhost:3000",
           "STRIDASH_API_TOKEN": "sdat_…"
         }
       }
     }
   }
   ```

## Tools

| Tool | Purpose |
| --- | --- |
| `search_activities` | newest-first activity feed, optional `from`/`to`/`limit` |
| `get_activity` | detail + providers + per-sample series for one activity |
| `similar_activities` | comparison candidates for one activity |
| `get_measurements` | weigh-ins/body composition + blood pressure |
| `get_sleep` | nightly stages, score, HRV, body-battery change |
| `get_daily_wellness` | steps, floors, calories, resting HR, stress, battery |
| `get_gear` | gear usage/thresholds and Stridash components |
| `get_connections` | providers, statuses and last-sync times |

All tools are read-only. They return the API JSON as pretty-printed text; no
provider credentials or tokens are exposed.

## Current limitations

- **stdio transport only**. Streamable HTTP for remote MCP clients is the next
  step.
- No write tools (manual entry/sync triggers) yet; this is deliberate for the
  first MCP surface.
- The MCP process is stateless; the API token is the entire session.
- If the token expires or is revoked, tools return the API's `401` as a tool
  error. Create a new token and restart the process.
