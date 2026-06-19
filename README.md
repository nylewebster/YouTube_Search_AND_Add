# YouTube Playlist Agent — MCP Server

An MCP server that lets Claude search YouTube and manage your playlists
directly, just by asking in plain language. Supports two modes:

- **Local mode** (`src/index-stdio.js`) — for Claude Desktop / Claude Code
  on your own computer. This is what you already have working.
- **Remote mode** (`src/index.js`) — for Claude on **any device, including
  mobile**, via a hosted URL. This is the new part.

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

If you already have this working from before, **nothing changes for you**.
Just make sure your Claude Desktop config points at `index-stdio.js` now
instead of `index.js`, since `index.js` is now the remote/HTTP entrypoint:

```json
{
  "mcpServers": {
    "youtube": {
      "command": "C:\\Program Files\\nodejs\\node.exe",
      "args": ["C:\\Users\\Tornyle\\youtube-mcp-server\\src\\index-stdio.js"]
    }
  }
}
```

(Only the filename changed: `index.js` -> `index-stdio.js`.)

If setting this up fresh:
```bash
npm install
npm run auth
```

---

## Part 2 — Remote setup (Claude Mobile, via Railway)

This makes the server reachable over the internet so Claude on your phone
can use it, without your computer needing to be on.

### Step 1 — Generate an access token

This is a password that protects your server from strangers on the
internet — different from your Google credentials. Run:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Copy the long string it prints. You'll paste this into Railway's dashboard
in Step 4, and into Claude's connector settings in Step 7.

### Step 2 — Push this project to GitHub

1. Create a free account at github.com if you don't have one
2. Create a new repository (e.g. `youtube-mcp-server`) — keep it **Private**
3. Upload this entire project folder to the repo. Easiest way without git
   command-line: on the repo page, click **Add file -> Upload files**, then
   drag in everything *except* `node_modules` and `.env`

### Step 3 — Create a Railway account and project

1. Go to railway.app and sign up (GitHub login is easiest)
2. Click **New Project -> Deploy from GitHub repo**
3. Select the repo you just created
4. Railway will detect it's a Node project automatically

### Step 4 — Set environment variables

In your Railway project, go to the **Variables** tab and add these (same
values as your local `.env`, plus the new token):

| Variable | Value |
|---|---|
| `GOOGLE_CLIENT_ID` | (from your local `.env`) |
| `GOOGLE_CLIENT_SECRET` | (from your local `.env`) |
| `GOOGLE_REFRESH_TOKEN` | (from your local `.env`) |
| `DEFAULT_PLAYLIST_NAME` | `Using Claude AI` |
| `DEFAULT_RESULT_COUNT` | `10` |
| `MCP_ACCESS_TOKEN` | (the long string from Step 1) |

Railway sets `PORT` automatically — you don't need to add it.

### Step 5 — Set the start command

In **Settings -> Deploy**, set the start command to:
```
node src/index.js
```

Railway should redeploy automatically. Once it's done, it'll show you a
public URL like:
```
https://youtube-mcp-server-production-xxxx.up.railway.app
```

### Step 6 — Verify it's alive

Visit `https://your-railway-url.up.railway.app/health` in any browser —
you should see:
```json
{"status":"ok"}
```
If you see an error instead, check Railway's **Deployments -> View Logs**
for what went wrong (most likely a missing environment variable).

### Step 7 — Connect it to Claude Mobile

1. Open the Claude app on your phone
2. Go to **Settings -> Connectors** (naming may vary)
3. Look for **Add custom connector** or **Add MCP server**
4. Enter:
   - **URL**: `https://your-railway-url.up.railway.app/mcp`
   - **Authorization header**: `Bearer <your MCP_ACCESS_TOKEN>`

If the mobile app doesn't expose a custom-connector option directly, the
same URL + token can be added from claude.ai in a desktop browser under
**Settings -> Connectors -> Add custom connector**, and it'll sync to your
mobile app automatically since connectors are tied to your account, not
the device.

### Step 8 — Test it

On your phone, ask Claude:
> "What YouTube playlists do I have?"

If it calls the tool and returns real playlist names, you're fully set up
on mobile.

---

## Security notes

- `MCP_ACCESS_TOKEN` is the only thing standing between your YouTube
  account and anyone who discovers your Railway URL. Treat it like a
  password.
- Keep the GitHub repo **private**.
- If you ever suspect the token leaked, generate a new one (Step 1) and
  update it in Railway's Variables tab.

## Troubleshooting

**Railway deploy fails / crashes on start** — check Variables tab for
typos, and check Logs for the exact error. Most common cause: a missing
`MCP_ACCESS_TOKEN` (the server refuses to start without one, by design).

**"Unauthorized" when Claude tries to connect** — the Bearer token in
Claude's connector settings doesn't match `MCP_ACCESS_TOKEN` in Railway.

**Works on /health but Claude says it can't connect** — double check the
URL ends in `/mcp`, not just the bare Railway URL.

**"Missing YouTube credentials" in Railway logs** — `GOOGLE_REFRESH_TOKEN`
wasn't set or copied correctly into Railway's Variables tab.
