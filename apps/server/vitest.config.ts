import { defineConfig } from "vitest/config";

/**
 * Two projects:
 *  - unit: provider normalize/mapping + sync-service orchestration (mocked
 *    I/O, no database, runs everywhere in milliseconds)
 *  - integration: the real Hono app over a throwaway Postgres started by
 *    testcontainers (tests/integration/setup.ts; Docker required)
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["tests/*.test.ts"],
        },
      },
      {
        test: {
          name: "integration",
          include: ["tests/integration/*.test.ts"],
          setupFiles: ["tests/integration/setup.ts"],
          testTimeout: 60_000,
        },
      },
    ],
  },
});
