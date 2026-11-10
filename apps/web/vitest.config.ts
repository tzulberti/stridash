import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // pure helpers only — no component/DOM tests yet
    include: ["src/**/*.test.ts"],
  },
});
