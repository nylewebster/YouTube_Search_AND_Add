#!/usr/bin/env node
/**
 * One-time authorization script.
 *
 * Spins up a tiny local web server on http://127.0.0.1:8765/callback,
 * opens the Google consent screen pointed at that local URL, and
 * captures the authorization code automatically when Google redirects
 * back — no copy/pasting JSON or OAuth Playground codes required.
 *
 * Run: npm run auth
 */
import http from 'node:http';
import { URL } from 'node:url';
import { exec } from 'node:child_process';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import readline from 'node:readline';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(__dirname, '..', '.env');

const PORT = 8765;
const REDIRECT_URI = `http://127.0.0.1:${PORT}/callback`;
const SCOPES = [
  'https://www.googleapis.com/auth/youtube',
  'https://www.googleapis.com/auth/youtube.force-ssl'
].join(' ');

function loadEnv() {
  const env = {};
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, 'utf8').split('\n')) {
      const m = line.match(/^([A-Z_]+)=(.*)$/);
      if (m) env[m[1]] = m[2];
    }
  }
  return env;
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, ans => { rl.close(); resolve(ans.trim()); }));
}

function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'start'
    : 'xdg-open';
  exec(`${cmd} "${url}"`, () => {});
}

async function main() {
  const env = loadEnv();
  let clientId = env.GOOGLE_CLIENT_ID;
  let clientSecret = env.GOOGLE_CLIENT_SECRET;

  if (!clientId) clientId = await ask('Google OAuth Client ID: ');
  if (!clientSecret) clientSecret = await ask('Google OAuth Client Secret: ');

  console.log(`
⚠  Before continuing, make sure this exact redirect URI is registered
   in Google Cloud Console → Credentials → your OAuth Client:

   ${REDIRECT_URI}

`);
  await ask('Press Enter once that is confirmed... ');

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: SCOPES,
    access_type: 'offline',
    prompt: 'consent'
  });
  const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params}`;

  const code = await new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, REDIRECT_URI);
      if (url.pathname !== '/callback') { res.end('ok'); return; }
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');
      res.setHeader('Content-Type', 'text/html');
      if (error) {
        res.end(`<h2>Authorization failed: ${error}</h2><p>You can close this tab.</p>`);
        server.close();
        reject(new Error(error));
        return;
      }
      res.end('<h2>✅ Authorized! You can close this tab and return to the terminal.</h2>');
      server.close();
      resolve(code);
    });
    server.listen(PORT, () => {
      console.log(`Opening browser for Google sign-in...\nIf it doesn't open automatically, visit:\n${authUrl}\n`);
      openBrowser(authUrl);
    });
  });

  console.log('Exchanging code for tokens...');
  const body = new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: REDIRECT_URI,
    grant_type: 'authorization_code'
  });

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString()
  });
  const data = await res.json();

  if (!data.refresh_token) {
    console.error('\n❌ No refresh token returned.', data);
    console.error('\nIf you have authorized this app before, revoke access at');
    console.error('https://myaccount.google.com/permissions and run `npm run auth` again —');
    console.error('Google only issues a refresh token on the first consent.');
    process.exit(1);
  }

  const envOut = `GOOGLE_CLIENT_ID=${clientId}
GOOGLE_CLIENT_SECRET=${clientSecret}
GOOGLE_REFRESH_TOKEN=${data.refresh_token}
DEFAULT_PLAYLIST_NAME=${env.DEFAULT_PLAYLIST_NAME || 'Using Claude AI'}
DEFAULT_RESULT_COUNT=${env.DEFAULT_RESULT_COUNT || '10'}
`;
  writeFileSync(envPath, envOut);
  console.log(`\n✅ Saved credentials and refresh token to ${envPath}`);
  console.log('You will not need to run this again unless you revoke access.');
}

main().catch(err => { console.error(err); process.exit(1); });
