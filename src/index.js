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
import { createYouTubeClient, toolDefinitions as ytToolDefinitions, handleToolCall as handleYtToolCall } from './youtube-tools.js';
import { createStackExchangeClient, toolDefinitions as seToolDefinitions, handleToolCall as handleSeToolCall } from './stackexchange-tools.js';
import { createCredibilityClient, toolDefinitions as credToolDefinitions, handleToolCall as handleCredToolCall } from './credibility-tools.js';
import { createOrchestratorClient, toolDefinitions as orchToolDefinitions, handleToolCall as handleOrchToolCall } from './orchestrator-tools.js';
import { createStackExchangeSmartSearchClient, toolDefinitions as seSmartToolDefinitions, handleToolCall as handleSeSmartToolCall } from './stackexchange-smart-search-tools.js';
import { createResearchBriefClient, toolDefinitions as briefToolDefinitions, handleToolCall as handleBriefToolCall } from './research-brief-tools.js';
import fs from 'node:fs';
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
const se = createStackExchangeClient();
const cred = createCredibilityClient({ stackExchangeClient: se, youtubeClient: yt });
const orch = createOrchestratorClient({ credibilityClient: cred, youtubeClient: yt, stackExchangeClient: se });
const seSmart = createStackExchangeSmartSearchClient({ stackExchangeClient: se });
const brief = createResearchBriefClient({ youtubeClient: yt, credibilityClient: cred, stackExchangeSmartSearchClient: seSmart });

// Merge tool definitions from all sources, and build a name -> handler
// lookup so the call handler below knows which client/dispatcher to route
// each tool to. A Map instead of per-service Sets/branches, since a third
// (and eventually fourth, once Reddit lands) service makes binary checks
// awkward fast.
const allToolDefinitions = [...ytToolDefinitions, ...seToolDefinitions, ...credToolDefinitions, ...orchToolDefinitions, ...seSmartToolDefinitions, ...briefToolDefinitions];

const toolRouter = new Map([
  ...ytToolDefinitions.map((t) => [t.name, (n, a) => handleYtToolCall(yt, n, a)]),
  ...seToolDefinitions.map((t) => [t.name, (n, a) => handleSeToolCall(se, n, a)]),
  ...credToolDefinitions.map((t) => [t.name, (n, a) => handleCredToolCall(cred, n, a)]),
  ...orchToolDefinitions.map((t) => [t.name, (n, a) => handleOrchToolCall(orch, n, a)]),
  ...seSmartToolDefinitions.map((t) => [t.name, (n, a) => handleSeSmartToolCall(seSmart, n, a)]),
  ...briefToolDefinitions.map((t) => [t.name, (n, a) => handleBriefToolCall(brief, n, a)]),
]);

if (!process.env.OPENAI_API_KEY) {
  console.error('WARNING: OPENAI_API_KEY is not set. The Whisper transcript fallback will be skipped');
  console.error('whenever YouTube captions are unavailable — summaries will drop to metadata-only instead.');
}

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('WARNING: ANTHROPIC_API_KEY is not set. The vibe classifier in credibility_check will');
  console.error('fail silently — scores will return without vibe distributions until this is set.');
}

if (!process.env.STACKEXCHANGE_API_KEY) {
  console.error('NOTE: STACKEXCHANGE_API_KEY is not set. Stack Exchange tools will work but are capped');
  console.error('at 300 requests/day/IP instead of 10,000 — register a free key at stackapps.com if needed.');
}

if (process.env.YTDLP_COOKIES_B64) {
  fs.writeFileSync('/tmp/cookies.txt', Buffer.from(process.env.YTDLP_COOKIES_B64, 'base64'));
  console.log('Decoded YTDLP_COOKIES_B64 to /tmp/cookies.txt');
}

function buildServer() {
  const server = new Server(
    { name: 'youtube-playlist-agent', version: '2.0.0' },
    { capabilities: { tools: {} } }
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    console.error(`[tools/list] returning ${allToolDefinitions.length} tools: ${allToolDefinitions.map(t => t.name).join(', ')}`);
    return { tools: allToolDefinitions };
  });
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      const handler = toolRouter.get(name);
      if (!handler) {
        throw new Error(`Unknown tool: ${name}`);
      }
      const content = await handler(name, args);
      return { content };
    } catch (err) {
      // NOTE: added for debugging — logs the real error to Railway logs
      // instead of letting it disappear silently. Safe to leave in
      // permanently; it only writes to stderr.
      console.error('[tools/call error]', name, err.stack || err.message);
      return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
    }
  });
  return server;
}

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Log every incoming request so Railway's log view shows real traffic,
// not just startup messages. Helpful for diagnosing whether Claude is
// actually reaching this server during connect/refresh actions.
app.use((req, res, next) => {
  console.error(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

registerOAuthRoutes(app, { baseUrl: BASE_URL });

app.get('/health', (req, res) => res.json({ status: 'ok' }));

// Credibility viewer endpoint — called by the deployed credibility-viewer
// service (and the local Vite dev proxy) to run a credibility check and
// return the JSON result. Auth is a simple Bearer token check against
// OAUTH_CLIENT_SECRET rather than the full MCP OAuth flow, since this is
// a single-user personal tool and the viewer is already behind obscurity.
app.post('/credibility-render', async (req, res) => {
  const authHeader = req.headers['authorization'] ?? '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!token || token !== process.env.OAUTH_CLIENT_SECRET) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const { input, includeVibe = true } = req.body ?? {};
  if (!input) {
    res.status(400).json({ error: 'Missing required field: input' });
    return;
  }

  try {
    const result = await orch.checkCredibility({ input, includeVibe });
    res.json(result);
  } catch (err) {
    console.error('[credibility-render] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

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

// NOTE: added for debugging — these two handlers catch anything that
// escapes every other try/catch in this file (e.g. a rejected promise
// nobody awaited, or a synchronous throw inside SDK transport code).
// Without these, that class of error fails completely silently — no log
// line at all, which is what made the original bug hard to pin down.
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err.stack || err.message);
});

app.listen(PORT, () => {
  console.error(`YouTube MCP server listening on port ${PORT} (HTTP/OAuth mode).`);
  console.error(`Base URL: ${BASE_URL}`);
  console.error(`Health check: GET /health`);
  console.error(`MCP endpoint:  POST/GET/DELETE /mcp`);
  console.error(`OAuth metadata: GET /.well-known/oauth-authorization-server`);
});
