#!/usr/bin/env node
/**
 * Remote (HTTP) entrypoint — run this on a host like Railway so Claude on
 * any device, including mobile, can reach it over the internet.
 *
 * Auth model: real OAuth 2.0 (authorization code + PKCE), implemented in
 * oauth.js, using a fixed Client ID/Secret you set yourself as environment
 * variables — see README Part 2 for the full setup walkthrough.
 */
import { config } from 'dotenv';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.join(__dirname, '..', '.env') }); // no-op on Railway; useful for local HTTP testing

import express from 'express';
import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  isInitializeRequest
} from '@modelcontextprotocol/sdk/types.js';
import { createYouTubeClient, toolDefinitions, handleToolCall } from './youtube-tools.js';
import { registerOAuthRoutes, validateAccessToken } from './oauth.js';

const PORT = process.env.PORT || 3000;

// BASE_URL must be your actual public Railway URL (e.g.
// https://youtubesearchandadd-production.up.railway.app). It's used inside
// the OAuth metadata documents, so it has to be correct and exact — no
// trailing slash.
const BASE_URL = process.env.BASE_URL;
if (!BASE_URL) {
  console.error('FATAL: BASE_URL is not set. Set it to this server\'s public URL, e.g.');
  console.error('  https://youtubesearchandadd-production.up.railway.app');
  process.exit(1);
}

const yt = createYouTubeClient();

function buildServer() {
  const server = new Server(
    { name: 'youtube-playlist-agent', version: '2.0.0' },
    { capabilities: { tools: {} } }
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toolDefinitions }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      const content = await handleToolCall(yt, name, args);
      return { content };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
    }
  });
  return server;
}

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

registerOAuthRoutes(app, { baseUrl: BASE_URL });

app.get('/health', (req, res) => res.json({ status: 'ok' }));

function requireAuth(req, res, next) {
  if (!validateAccessToken(req)) {
    res
      .status(401)
      .set('WWW-Authenticate', `Bearer resource_metadata="${BASE_URL}/.well-known/oauth-protected-resource"`)
      .json({ error: 'Unauthorized' });
    return;
  }
  next();
}

const sessions = {};

app.post('/mcp', requireAuth, async (req, res) => {
  const sessionId = req.headers['mcp-session-id'];
  let transport;

  if (sessionId && sessions[sessionId]) {
    transport = sessions[sessionId];
  } else if (!sessionId && isInitializeRequest(req.body)) {
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => { sessions[id] = transport; }
    });
    transport.onclose = () => {
      if (transport.sessionId) delete sessions[transport.sessionId];
    };
    const server = buildServer();
    await server.connect(transport);
  } else {
    res.status(400).json({ error: 'Bad Request: no valid session and not an initialize request' });
    return;
  }

  await transport.handleRequest(req, res, req.body);
});

app.get('/mcp', requireAuth, async (req, res) => {
  const sessionId = req.headers['mcp-session-id'];
  const transport = sessionId && sessions[sessionId];
  if (!transport) { res.status(400).send('Invalid or missing session'); return; }
  await transport.handleRequest(req, res);
});

app.delete('/mcp', requireAuth, async (req, res) => {
  const sessionId = req.headers['mcp-session-id'];
  const transport = sessionId && sessions[sessionId];
  if (!transport) { res.status(400).send('Invalid or missing session'); return; }
  await transport.handleRequest(req, res);
  delete sessions[sessionId];
});

app.listen(PORT, () => {
  console.error(`YouTube MCP server listening on port ${PORT} (HTTP/OAuth mode).`);
  console.error(`Base URL: ${BASE_URL}`);
  console.error(`Health check: GET /health`);
  console.error(`MCP endpoint:  POST/GET/DELETE /mcp`);
  console.error(`OAuth metadata: GET /.well-known/oauth-authorization-server`);
});
