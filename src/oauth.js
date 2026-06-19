/**
 * Minimal OAuth 2.0 authorization server, just enough to satisfy Claude's
 * custom connector flow (RFC 8414 + RFC 9728 metadata, authorization code
 * grant with PKCE, no Dynamic Client Registration).
 *
 * This is NOT a general-purpose OAuth provider — it has exactly one
 * "user" (you) and one pre-registered client (Claude), both identified by
 * environment variables you set yourself. That's the right amount of
 * complexity for a personal single-user tool; a multi-tenant SaaS would
 * need much more (per-user accounts, real DCR, token revocation lists,
 * etc).
 *
 * Flow:
 *  1. Claude GETs /.well-known/oauth-authorization-server to discover endpoints
 *  2. Claude redirects the user's browser to GET /oauth/authorize
 *  3. This server shows a one-button "Approve" page (no real login screen —
 *     since only you know this server's URL and the OAUTH_CLIENT_SECRET,
 *     reaching this page at all is already a form of authentication)
 *  4. On approve, redirects to Claude's callback with a short-lived code
 *  5. Claude POSTs that code to /oauth/token, gets back an access token
 *  6. Claude calls /mcp with `Authorization: Bearer <access_token>`
 */
import { randomBytes, createHash } from 'node:crypto';

const CLIENT_ID = process.env.OAUTH_CLIENT_ID;
const CLIENT_SECRET = process.env.OAUTH_CLIENT_SECRET;

// In-memory stores. Fine for a single-instance personal server — these
// reset on redeploy, which just means you re-approve once after a deploy.
const authCodes = new Map();   // code -> { clientId, redirectUri, codeChallenge, expiresAt }
const accessTokens = new Map(); // token -> { clientId, expiresAt }

const CODE_TTL_MS = 60_000;          // auth codes expire in 60s, same as Google's
const TOKEN_TTL_MS = 60 * 60 * 1000; // access tokens last 1 hour

function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function verifyPkce(verifier, challenge, method) {
  if (method === 'plain') return verifier === challenge;
  if (method === 'S256') {
    const hash = createHash('sha256').update(verifier).digest();
    return base64url(hash) === challenge;
  }
  return false;
}

export function registerOAuthRoutes(app, { baseUrl }) {
  if (!CLIENT_ID || !CLIENT_SECRET) {
    console.error('FATAL: OAUTH_CLIENT_ID / OAUTH_CLIENT_SECRET are not set.');
    console.error('Generate values for these yourself (any random strings) and set them');
    console.error('as environment variables, then enter the same values as the Client ID');
    console.error('and Client Secret when adding this connector in Claude.');
    process.exit(1);
  }

  // ---- RFC 9728: Protected Resource Metadata ----
  app.get('/.well-known/oauth-protected-resource', (req, res) => {
    res.json({
      resource: `${baseUrl}/mcp`,
      authorization_servers: [baseUrl]
    });
  });
  // Claude has been observed probing this path with /mcp appended too.
  app.get('/.well-known/oauth-protected-resource/mcp', (req, res) => {
    res.json({ resource: `${baseUrl}/mcp`, authorization_servers: [baseUrl] });
  });

  // ---- RFC 8414: Authorization Server Metadata ----
  app.get('/.well-known/oauth-authorization-server', (req, res) => {
    res.json({
      issuer: baseUrl,
      authorization_endpoint: `${baseUrl}/oauth/authorize`,
      token_endpoint: `${baseUrl}/oauth/token`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256', 'plain'],
      token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'],
      scopes_supported: ['mcp:tools']
    });
  });

  // ---- Authorization endpoint: shows an approve page ----
  app.get('/oauth/authorize', (req, res) => {
    const { client_id, redirect_uri, state, code_challenge, code_challenge_method, response_type } = req.query;

    if (response_type !== 'code') {
      res.status(400).send('Only response_type=code is supported');
      return;
    }
    if (client_id !== CLIENT_ID) {
      res.status(400).send('Unknown client_id. Check the Client ID entered in Claude matches OAUTH_CLIENT_ID.');
      return;
    }
    if (!redirect_uri) {
      res.status(400).send('Missing redirect_uri');
      return;
    }

    // Single-button approve page. Reaching this URL at all requires
    // knowing this server's address, which only you and Claude (once
    // configured) know — there's no separate password prompt here.
    res.send(`
      <!DOCTYPE html>
      <html>
      <head><title>Authorize YouTube Playlist Agent</title>
      <style>
        body { font-family: -apple-system, sans-serif; background:#0a0a0a; color:#f0f0f0;
               display:flex; align-items:center; justify-content:center; height:100vh; margin:0; }
        .card { background:#141414; border:1px solid #2a2a2a; border-radius:16px; padding:2rem; max-width:380px; text-align:center; }
        h2 { margin-top:0; }
        button { background:#FF0033; color:white; border:none; border-radius:8px; padding:0.75rem 1.5rem;
                 font-size:1rem; cursor:pointer; width:100%; margin-top:1rem; }
        button:hover { background:#cc0029; }
        .deny { background:transparent; border:1px solid #2a2a2a; color:#888; margin-top:0.5rem; }
      </style>
      </head>
      <body>
        <div class="card">
          <h2>Connect Claude</h2>
          <p>Allow Claude to search YouTube and manage your playlists?</p>
          <form method="POST" action="/oauth/authorize">
            <input type="hidden" name="client_id" value="${escapeHtml(client_id)}">
            <input type="hidden" name="redirect_uri" value="${escapeHtml(redirect_uri)}">
            <input type="hidden" name="state" value="${escapeHtml(state || '')}">
            <input type="hidden" name="code_challenge" value="${escapeHtml(code_challenge || '')}">
            <input type="hidden" name="code_challenge_method" value="${escapeHtml(code_challenge_method || 'plain')}">
            <button type="submit" name="decision" value="approve">Approve</button>
            <button type="submit" name="decision" value="deny" class="deny">Deny</button>
          </form>
        </div>
      </body>
      </html>
    `);
  });

  // Note: req.body for this POST is parsed by the global express.urlencoded()
  // middleware in index.js, since this form posts as application/x-www-form-urlencoded.

  app.post('/oauth/authorize', (req, res) => {
    const { client_id, redirect_uri, state, code_challenge, code_challenge_method, decision } = req.body;

    const redirectUrl = new URL(redirect_uri);
    if (decision !== 'approve') {
      redirectUrl.searchParams.set('error', 'access_denied');
      if (state) redirectUrl.searchParams.set('state', state);
      res.redirect(redirectUrl.toString());
      return;
    }

    const code = base64url(randomBytes(32));
    authCodes.set(code, {
      clientId: client_id,
      redirectUri: redirect_uri,
      codeChallenge: code_challenge || null,
      codeChallengeMethod: code_challenge_method || 'plain',
      expiresAt: Date.now() + CODE_TTL_MS
    });

    redirectUrl.searchParams.set('code', code);
    if (state) redirectUrl.searchParams.set('state', state);
    res.redirect(redirectUrl.toString());
  });

  // ---- Token endpoint ----
  app.post('/oauth/token', (req, res) => {
    const { grant_type, code, redirect_uri, client_id, client_secret, code_verifier, refresh_token } = req.body;

    // Client auth: accept credentials either in the body or via HTTP Basic auth.
    let authedClientId = client_id;
    let authedClientSecret = client_secret;
    const authHeader = req.headers.authorization || '';
    if (authHeader.startsWith('Basic ')) {
      const decoded = Buffer.from(authHeader.slice(6), 'base64').toString('utf8');
      const idx = decoded.indexOf(':');
      if (idx !== -1) {
        authedClientId = decoded.slice(0, idx);
        authedClientSecret = decoded.slice(idx + 1);
      }
    }
    if (authedClientId !== CLIENT_ID || authedClientSecret !== CLIENT_SECRET) {
      res.status(401).json({ error: 'invalid_client' });
      return;
    }

    if (grant_type === 'authorization_code') {
      const entry = authCodes.get(code);
      if (!entry || entry.expiresAt < Date.now()) {
        res.status(400).json({ error: 'invalid_grant', error_description: 'Code expired or unknown' });
        return;
      }
      authCodes.delete(code); // one-time use
      if (entry.redirectUri !== redirect_uri) {
        res.status(400).json({ error: 'invalid_grant', error_description: 'redirect_uri mismatch' });
        return;
      }
      if (entry.codeChallenge) {
        if (!code_verifier || !verifyPkce(code_verifier, entry.codeChallenge, entry.codeChallengeMethod)) {
          res.status(400).json({ error: 'invalid_grant', error_description: 'PKCE verification failed' });
          return;
        }
      }

      const accessToken = base64url(randomBytes(32));
      const refreshTokenValue = base64url(randomBytes(32));
      accessTokens.set(accessToken, { clientId: authedClientId, expiresAt: Date.now() + TOKEN_TTL_MS });
      accessTokens.set(refreshTokenValue, { clientId: authedClientId, isRefresh: true });

      res.json({
        access_token: accessToken,
        token_type: 'Bearer',
        expires_in: TOKEN_TTL_MS / 1000,
        refresh_token: refreshTokenValue,
        scope: 'mcp:tools'
      });
      return;
    }

    if (grant_type === 'refresh_token') {
      const entry = accessTokens.get(refresh_token);
      if (!entry || !entry.isRefresh) {
        res.status(400).json({ error: 'invalid_grant' });
        return;
      }
      const accessToken = base64url(randomBytes(32));
      accessTokens.set(accessToken, { clientId: authedClientId, expiresAt: Date.now() + TOKEN_TTL_MS });
      res.json({
        access_token: accessToken,
        token_type: 'Bearer',
        expires_in: TOKEN_TTL_MS / 1000,
        scope: 'mcp:tools'
      });
      return;
    }

    res.status(400).json({ error: 'unsupported_grant_type' });
  });
}

/** Validates a bearer token from the Authorization header. */
export function validateAccessToken(req) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return false;
  const entry = accessTokens.get(token);
  if (!entry || entry.isRefresh) return false;
  if (entry.expiresAt < Date.now()) {
    accessTokens.delete(token);
    return false;
  }
  return true;
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
