import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { renderHeadersFile } from './src/lib/security-headers';

// Dev-only proxy: the app calls same-origin /api; requests are forwarded to
// the Hono server. In production the dashboard is served/sidecared next to
// the API, so no proxy is involved.
export default defineConfig({
  plugins: [
    react(),
    {
      name: 'stridash-security-headers',
      apply: 'build',
      // Netlify/Cloudflare Pages read `dist/_headers`; nginx/Caddy equivalents
      // live in docs/deployment.md. Emitting it from the same constants keeps
      // the CSP from drifting.
      generateBundle() {
        this.emitFile({
          type: 'asset',
          fileName: '_headers',
          source: renderHeadersFile(),
        });
      },
    },
  ],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:3000', changeOrigin: true },
    },
  },
});
