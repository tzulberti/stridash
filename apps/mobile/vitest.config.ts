import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Pure helpers first; React Native screen tests need a separate preset.
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
