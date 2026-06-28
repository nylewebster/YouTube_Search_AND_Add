import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

// The bearer token and target URL are read here, in the Vite config, which runs
// in Node — NOT in client code. We deliberately use loadEnv with an empty prefix
// so RENDER_TOKEN / RAILWAY_URL are visible to the dev server but are never
// inlined into the browser bundle (only VITE_-prefixed vars are exposed to the
// client). The browser only ever calls the same-origin /api path; the dev-server
// proxy below rewrites it and attaches the Authorization header server-side.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const target = env.RAILWAY_URL || 'https://youtubesearchandadd-production.up.railway.app';
  const token = env.RENDER_TOKEN || '';

  if (!token) {
    console.warn(
      '[credibility-viewer] RENDER_TOKEN is not set — requests to /api will be rejected (401). ' +
      'Copy .env.example to .env and set RENDER_TOKEN to the server\'s OAUTH_CLIENT_SECRET.'
    );
  }

  return {
    plugins: [react()],
    server: {
      proxy: {
        '/api': {
          target,
          changeOrigin: true,
          rewrite: (p) => p.replace(/^\/api/, ''),
          configure: (proxy) => {
            proxy.on('proxyReq', (proxyReq) => {
              if (token) proxyReq.setHeader('Authorization', `Bearer ${token}`);
            });
          },
        },
      },
    },
  };
});
