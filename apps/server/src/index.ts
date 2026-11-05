import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { loadEnv } from "./env.js";
import { UnauthorizedError } from "./auth.js";
import { authRoutes } from "./routes/auth.js";
import { connectionRoutes } from "./routes/connections.js";
import { dataRoutes } from "./routes/data.js";

const env = loadEnv();

const app = new Hono();

// App-level context typing
type AppContext = {
  Variables: { userId: string };
};
type TypedHono = Hono<AppContext>;

// ─── Public ──────────────────────────────────────────────────────────────────

app.get("/api/health", (c) =>
  c.json({ status: "ok" as const, version: env.STRIDASH_VERSION }),
);

app.route("/api/auth", authRoutes(env));

// ─── Authenticated ───────────────────────────────────────────────────────────

const api: TypedHono = new Hono();
api.route("/connections", connectionRoutes(env));
api.route("/", dataRoutes(env));

app.route("/api", api);

// ─── Errors ──────────────────────────────────────────────────────────────────

app.onError((err, c) => {
  if (err instanceof UnauthorizedError) return c.json({ error: "Unauthorized" }, 401);
  console.error("[error]", err);
  return c.json({ error: "Internal server error" }, 500);
});

serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  console.log(`Stridash server v${env.STRIDASH_VERSION} listening on http://localhost:${info.port}`);
  console.log(`   health: http://localhost:${info.port}/api/health`);
});
