/**
 * server.js — production server for the credibility viewer.
 *
 * In dev, Vite's built-in proxy handles /api → Railway + Bearer token injection,
 * all server-side. In production (Railway), there's no Vite dev server, so this
 * Express server does the same job:
 *
 *   - Serves the static Vite build from ./dist
 *   - Proxies POST /api/* to RAILWAY_URL, attaching the RENDER_TOKEN as a
 *     Bearer header — token never touches the browser bundle
 *   - Falls back to index.html for client-side routing (SPA behavior)
 *
 * Environment variables (set on Railway, same as the MCP server):
 *   RENDER_TOKEN   — must match the MCP server's OAUTH_CLIENT_SECRET
 *   RAILWAY_URL    — MCP server base URL (default: youtubesearchandadd-production...)
 *   PORT           — Railway sets this automatically
 */

import express from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT || 4173;
const RAILWAY_URL = process.env.RAILWAY_URL || 'https://youtubesearchandadd-production.up.railway.app';
const RENDER_TOKEN = process.env.RENDER_TOKEN || '';

if (!RENDER_TOKEN) {
  console.error('[credibility-viewer] WARNING: RENDER_TOKEN is not set — /api requests will be rejected (401).');
}

const app = express();

// Proxy /api/* → Railway MCP server, injecting the Bearer token server-side.
// The browser never sees the token — same guarantee as the Vite dev proxy.
app.use('/api', createProxyMiddleware({
  target: RAILWAY_URL,
  changeOrigin: true,
  pathRewrite: { '^/api': '' },
  on: {
    proxyReq: (proxyReq) => {
      if (RENDER_TOKEN) {
        proxyReq.setHeader('Authorization', `Bearer ${RENDER_TOKEN}`);
      }
    },
    error: (err, req, res) => {
      console.error('[credibility-viewer] proxy error:', err.message);
      res.status(502).json({ error: 'Proxy error', detail: err.message });
    },
  },
}));

// Serve the Vite static build
app.use(express.static(path.join(__dirname, 'dist')));

// SPA fallback — all non-API routes serve index.html so React Router works
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Credibility viewer running on port ${PORT}`);
  console.log(`Proxying /api → ${RAILWAY_URL}`);
});
