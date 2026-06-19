# YouTube Playlist Agent — MCP Server

An MCP server that lets Claude search YouTube and manage your playlists
directly, just by asking in plain language. Supports two modes:

- **Local mode** (`src/index-stdio.js`) — for Claude Desktop / Claude Code
  on your own computer.
- **Remote mode** (`src/index.js`) — for Claude on **any device, including
  mobile**, via a hosted URL with real OAuth 2.0 login (required — Claude's
  connector UI does not accept a plain static API key/bearer token).

The YouTube logic (search, playlists, add-with-dedup) is identical in both
— it lives in `youtube-tools.js` and `youtube-client.js` and is shared.

## Tools available

- `youtube_search_and_add` — search and auto-add top N results to a playlist
- `youtube_search` — search without adding
- `youtube_add_videos` — add specific video IDs
- `youtube_list_playlists` — list your playlists
- `youtube_create_playlist` — create a new playlist

---

## Part 1 — Local setup (Claude Desktop / Claude Code)

```bash
npm install
npm run auth
```

Claude Desktop config (Windows example):
```json
{
  "mcpServers": {
    "youtube": {
      "command": "C:\\Program Files\\nodejs\\node.exe",
      "args": ["C:\\path\\to\\youtube-mcp-server\\src\\index-stdio.js"]
    }
  }
}
```

---

## Part 2 — Remote setup (Claude Mobile, via Railway)

### Why this needs real OAuth

Claude's "Add custom connector" screen only accepts OAuth Client ID +
Secret — there's no field for a plain static token. So this server
implements a minimal OAuth 2.0 provider (`src/oauth.js`): a fixed Client
ID/Secret that you make up yourself (not tied to Google at all), an
approve-button login page, and standard authorization-code+PKCE token
issuance. It's intentionally simple — built for one user (you), not a
multi-tenant service.

### Step 1 — Generate your own Client ID and Secret

These are NOT your Google credentials — they're a separate pair you invent
specifically to gate access to this server. Run twice:
```bash
node -e "console.log(require('crypto').randomBytes(16).toString('hex'))"
```
Save the two outputs — you'll use one as `OAUTH_CLIENT_ID`, the other as
`OAUTH_CLIENT_SECRET`.

### Step 2 — Push this project to GitHub

1. Create a private repo (e.g. `youtube-mcp-server`)
2. Upload everything except `node_modules` and `.env`

### Step 3 — Deploy on Railway

1. railway.app → New Project → Deploy from GitHub repo → select your repo
2. **Settings → Deploy → Start Command**: `node src/index.js`
3. Note the public URL Railway assigns, e.g.
   `https://youtubesearchandadd-production.up.railway.app`
   (no trailing slash when you use it below)

### Step 4 — Set environment variables

Railway → **Variables** tab:

| Variable | Value |
|---|---|
| `GOOGLE_CLIENT_ID` | from your local `.env` |
| `GOOGLE_CLIENT_SECRET` | from your local `.env` |
| `GOOGLE_REFRESH_TOKEN` | from your local `.env` |
| `DEFAULT_PLAYLIST_NAME` | `Using Claude AI` |
| `DEFAULT_RESULT_COUNT` | `10` |
| `BASE_URL` | your exact Railway URL from Step 3, no trailing slash |
| `OAUTH_CLIENT_ID` | first value from Step 1 |
| `OAUTH_CLIENT_SECRET` | second value from Step 1 |

Railway sets `PORT` itself — don't add it.

Save → Railway redeploys automatically.

### Step 5 — Verify the deploy

Visit these two URLs in a browser (replace with your real domain):
```
https://your-app.up.railway.app/health
https://your-app.up.railway.app/.well-known/oauth-authorization-server
```
The first should show `{"status":"ok"}`. The second should show a JSON
document listing `authorization_endpoint`, `token_endpoint`, etc. If
either fails, check Railway's **Deployments → Logs**.

### Step 6 — Add the connector in Claude

1. On **claude.ai** (desktop browser — mobile can't add new connectors,
   only use ones already added) go to **Settings → Connectors → Add
   custom connector**
2. **URL**: `https://your-app.up.railway.app/mcp`
3. It should prompt for OAuth **Client ID** and **Client Secret** — enter
   the two values from Step 1
4. Click **Connect** — this opens the approve page hosted by your own
   server; click **Approve**
5. You should land back in Claude with the connector showing as connected

### Step 7 — Use it on mobile

Once added on claude.ai, the connector is available in the Claude mobile
app automatically (connectors are tied to your account, not the device).
Try asking:
> "What YouTube playlists do I have?"

---

## Known rough edges (current as of mid-2026)

Claude's remote-connector OAuth support is still maturing. If Step 6
doesn't work cleanly the first time, this is a documented pattern, not
necessarily something wrong with this server specifically — common
failure modes seen in the wild include:
- Connector shows "connected" but no tools load (try removing and
  re-adding the connector)
- A 401 missing the `WWW-Authenticate` header causes Claude to give up
  silently (this server sends it, but worth checking via browser dev
  tools / curl if issues persist)
- Metadata discovery paths can vary slightly; this server implements the
  two main `.well-known` variants observed in the wild

If you get stuck, the most useful next step is checking Railway's logs
**while** retrying the connection in Claude — you'll see exactly which
request Claude made last before it gave up.

## Troubleshooting

**"FATAL: BASE_URL is not set"** — add it in Railway Variables, exact
public URL, no trailing slash.

**"FATAL: OAUTH_CLIENT_ID / OAUTH_CLIENT_SECRET are not set"** — add both
in Railway Variables (Step 1 values).

**Claude says "Unknown client_id"** — the Client ID typed into Claude's
connector form doesn't match `OAUTH_CLIENT_ID` in Railway. Re-copy
carefully.

**Approve page loads but redirect fails** — check `BASE_URL` exactly
matches the real Railway domain (Railway sometimes shows a slightly
different "public" vs "internal" URL — use the public one).

**"Missing YouTube credentials" in logs** — `GOOGLE_REFRESH_TOKEN` wasn't
copied correctly into Railway's Variables tab.
