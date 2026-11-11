import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev-only proxy: the app calls same-origin /api; requests are forwarded to
// the Hono server. In production the dashboard is served/sidecared next to
// the API, so no proxy is involved.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:3000', changeOrigin: true },
    },
  },
});
