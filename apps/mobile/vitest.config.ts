import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: [
      // Screen tests render the Expo web target (react-native-web primitives)
      // in jsdom; the native app bundle stays untouched.
      { find: /^react-native$/, replacement: 'react-native-web' },
      { find: '@', replacement: fileURLToPath(new URL('./src', import.meta.url)) },
    ],
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
