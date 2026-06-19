#!/usr/bin/env node
/**
 * Remote (HTTP) entrypoint — run this on a host like Railway so Claude on
 * any device, including mobile, can reach it over the internet.
 *
 * Auth model: every request must include
 *   Authorization: Bearer <MCP_ACCESS_TOKEN>
 * MCP_ACCESS_TOKEN is a secret you generate yourself and set as an
 * environment variable on the host — it's not your Google credentials,
 * it's a separate password that gates access to this server specifically.
 * Without it, anyone who finds the URL could add/search videos using your
 * YouTube account, which is why this is non-optional for a public endpoint.
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

const PORT = process.env.PORT || 3000;
const ACCESS_TOKEN = process.env.MCP_ACCESS_TOKEN;

if (!ACCESS_TOKEN) {
  console.error('FATAL: MCP_ACCESS_TOKEN is not set. Refusing to start an unauthenticated public server.');
  console.error('Generate a long random secret and set it as an environment variable, e.g.:');
  console.error('  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
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

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (token !== ACCESS_TOKEN) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
}

app.get('/health', (req, res) => res.json({ status: 'ok' }));

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
  console.error(`YouTube MCP server listening on port ${PORT} (HTTP/remote mode).`);
  console.error(`Health check: GET /health`);
  console.error(`MCP endpoint:  POST/GET/DELETE /mcp  (Bearer token required)`);
});
