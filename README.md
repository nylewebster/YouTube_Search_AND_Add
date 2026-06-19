# YouTube Playlist Agent — MCP Server

An MCP server that lets Claude search YouTube and manage your playlists
directly, just by asking in plain language. Supports two modes:

- **Local mode** (`src/index-stdio.js`) — for Claude Desktop / Claude Code
  on your own computer.
- **Remote mode** (`src/index.js`) — for Claude on **any device, including
  mobile**, via a hosted URL with real OAuth 2.0 login (required — Claude's
  connector UI does not accept a plain static API key/bearer token).

The YouTube logic (search, playlists, add-with-dedup, transcript/summarize)
is identical in both — it lives in `youtube-tools.js`, `youtube-client.js`,
`transcript-client.js`, and `whisper-fallback.js`, and is shared.

## Tools available

- `youtube_search_and_add` — search and auto-add top N results to a playlist
- `youtube_search` — search without adding
- `youtube_add_videos` — add specific video IDs
- `youtube_list_playlists` — list your playlists
- `youtube_create_playlist` — create a new playlist
- `youtube_summarize_video` — summarize a video using its real transcript
  when one's available (YouTube captions → Whisper fallback → metadata-only,
  in that order — see Part 3)

---

## Part 1 — Local setup (Claude Desktop / Claude Code)

```bash
npm install
npm run auth
```

`npm run auth` walks you through Google OAuth locally and saves a refresh
token you'll reuse in Part 2.

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

Claude's "Add custom connector" screen only accepts an OAuth Client ID +
Secret — there's no field for a plain static token. So this server
implements a minimal OAuth 2.0 provider (`src/oauth.js`): a fixed Client
ID/Secret you make up yourself (not tied to Google at all), an
approve-button login page, and standard authorization-code+PKCE token
issuance. It's intentionally simple — built for one user (you), not a
multi-tenant service.

### Step 1 — Generate your own Client ID and Secret

These are NOT your Google credentials — they're a separate pair you invent
specifically to gate access to this server. Run this twice:

```bash
node -e "console.log(require('crypto').randomBytes(16).toString('hex'))"
```

Save the two outputs — one becomes `OAUTH_CLIENT_ID`, the other
`OAUTH_CLIENT_SECRET`.

### Step 2 — Push this project to GitHub

1. Create a repo (public or private both work)
2. Push everything except `node_modules` and `.env` — make sure both are
   listed in `.gitignore` *before* your first commit. This matters even
   more if the repo is or might ever become public: anything ever
   committed stays in git history even after you delete the file later.

### Step 3 — Deploy on Railway

1. railway.app → New Project → Deploy from GitHub repo → select your repo
2. This repo now has a `Dockerfile` at the root, so Railway automatically
   switches from its default Nixpacks builder to Docker — you don't need
   to set a Start Command manually, since the Dockerfile's `CMD` already
   runs `node src/index.js`.
3. Note the public URL Railway assigns, e.g.
   `https://youtubesearchandadd-production.up.railway.app` (no trailing
   slash when you use it below)

### Step 4 — Set environment variables

Railway → **Variables** tab:

| Variable | Value | Required? |
|---|---|---|
| `GOOGLE_CLIENT_ID` | from your local `.env` | Yes |
| `GOOGLE_CLIENT_SECRET` | from your local `.env` | Yes |
| `GOOGLE_REFRESH_TOKEN` | from your local `.env` | Yes |
| `DEFAULT_PLAYLIST_NAME` | e.g. `Using Claude AI` | Yes |
| `DEFAULT_RESULT_COUNT` | e.g. `10` | Yes |
| `BASE_URL` | your exact Railway URL from Step 3, no trailing slash | Yes |
| `OAUTH_CLIENT_ID` | first value from Step 1 | Yes |
| `OAUTH_CLIENT_SECRET` | second value from Step 1 | Yes |
| `OPENAI_API_KEY` | from platform.openai.com — see Part 3 | Optional — without it, transcripts just skip straight to metadata-only whenever captions fail |

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

1. On claude.ai (desktop browser — mobile can't add new connectors, only
   use ones already added), go to **Settings → Connectors → Add custom
   connector**
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

## Part 3 — Whisper transcription fallback

### What this adds

`youtube_summarize_video` now tries three tiers, in order, and tells you
which one it used (via the `transcriptSource` field in its response):

1. **YouTube captions** (unofficial method, via `youtube-transcript-plus`)
   — free and fast, but breaks if a video has no captions, captions are
   disabled, or YouTube rate-limits the unofficial method.
2. **Whisper fallback** — if captions fail, downloads just the audio with
   `yt-dlp` and transcribes it with OpenAI's Whisper API. Costs money per
   call (OpenAI bills per minute of audio) and is slower, so it only runs
   as a fallback, never as the primary method.
3. **Metadata-only** — if both fail, you still get title/description/stats
   instead of an outright error.

### Setup

1. **Get an OpenAI API key** at platform.openai.com → API keys → Create
   new secret key.
2. Add it to Railway → Variables as `OPENAI_API_KEY`.
3. Save — Railway redeploys automatically.

That's the entire minimum setup. The `Dockerfile` already installs
`ffmpeg` and `yt-dlp` for you, so there's nothing else to install.

### Optional environment variables

| Variable | Default | What it does |
|---|---|---|
| `WHISPER_MODEL` | `whisper-1` | The OpenAI model used for transcription. Leave this as-is — it's currently the only OpenAI transcription model that returns the segment-level timestamps this server needs to chunk long transcripts. |
| `WHISPER_MAX_DURATION_SECONDS` | `1800` (30 min) | Videos longer than this are rejected before downloading, to avoid large OpenAI bills and slow requests. Raise it if you regularly summarize longer videos and are fine with the cost/time tradeoff. |
| `YTDLP_COOKIES_FILE` | unset | Path to a `cookies.txt` file (exported from a real logged-in browser session) that `yt-dlp` uses to look like an authenticated browser request. See the caveat below. |

### Known risk: YouTube may block downloads from Railway

YouTube increasingly bot-detects download requests coming from
cloud-provider IP ranges — Railway included — independent of whether your
code is correct. If Whisper fallback starts failing with download errors
on videos that clearly have audio, this is the likely cause, not a bug.

The workaround is `YTDLP_COOKIES_FILE`: export a `cookies.txt` from your
own browser (browser extensions like "Get cookies.txt" do this), get that
file onto the Railway instance somehow (a Railway volume, or committing it
as a secret file — both add setup complexity this guide doesn't cover),
and point the env var at its path. If that's more hassle than it's worth,
it's also reasonable to just accept that the Whisper fallback works
inconsistently, and let those specific videos drop to metadata-only.

### Cost note

OpenAI's Whisper API bills per minute of audio. A 10-minute video costs a
small fraction of a cent; this only adds up if you're regularly
summarizing many long videos that lack captions. `WHISPER_MAX_DURATION_SECONDS`
is your cost ceiling — set it to whatever you're comfortable with.

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

**Whisper fallback always fails** (`transcriptError.whisperFallback` shows
up every time) — first confirm `OPENAI_API_KEY` is actually set in
Railway, not just locally. Then check Railway's logs for the specific
error — it'll say whether it's a yt-dlp download failure, an audio-too-large
error, or an OpenAI API error, which point to different fixes.

**Build fails on Railway after adding the Dockerfile** — check the build
logs around the `apt-get install` / `curl` steps specifically; a transient
network blip during image build is the most common cause, and just
retriggering the deploy usually resolves it.

**`yt-dlp failed to download audio` in logs** — most likely YouTube
blocking the request from Railway's IP range (see "Known risk" in Part 3
above), though it's worth first ruling out that the video itself isn't
private, age-restricted, or region-locked.
