import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // pure helpers only — no component/DOM tests yet
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'json-summary'],
      reportsDirectory: 'coverage',
      include: ['src/**/*.{ts,tsx}'],
      // Translation payloads are data, not executable logic; including them
      // would dominate the total and hide which helpers are untested.
      exclude: ['src/**/*.test.ts', 'src/lib/i18n/**'],
    },
  },
});
