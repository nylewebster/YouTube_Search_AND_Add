# YouTube Playlist Agent — MCP Server

An MCP server that lets Claude search YouTube, manage your playlists, summarize
videos (real transcripts, not just metadata), read comments, and run
self-correcting searches — all just by asking in plain language. Supports two
modes:

- **Local mode** (`src/index-stdio.js`) — for Claude Desktop / Claude Code on
  your own computer.
- **Remote mode** (`src/index.js`) — for Claude on **any device, including
  mobile**, via a hosted URL with real OAuth 2.0 login (required — Claude's
  connector UI does not accept a plain static API key/bearer token).

The YouTube logic (search, playlists, add-with-dedup, transcripts, comments,
smart search) is shared between both modes — it lives in `youtube-tools.js`,
`youtube-client.js`, `transcript-client.js`, `whisper-fallback.js`, and
`query-refiner.js`.

## Tools available

| Tool | What it does |
|---|---|
| `youtube_search` | Search without adding anything |
| `youtube_search_and_add` | Search and auto-add top N results to a playlist |
| `youtube_smart_search_and_add` | Like the above, but with an LLM-judged refinement loop — retries with a better query if results don't actually match your stated goal. See Part 4. |
| `youtube_add_videos` | Add specific video IDs to a playlist |
| `youtube_list_playlists` | List your playlists |
| `youtube_create_playlist` | Create a new playlist |
| `youtube_summarize_video` | Summarize a video using its real transcript (captions → Whisper fallback → metadata-only). See Part 3. |
| `youtube_get_comments` | Get top-level comments for a video — useful for gauging audience reaction, sentiment, or common complaints |

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
Secret — there's no field for a plain static token. This server implements a
minimal OAuth 2.0 provider (`src/oauth.js`): a fixed Client ID/Secret you make
up yourself (not tied to Google at all), an approve-button login page, and
standard authorization-code+PKCE token issuance.

### Step 1 — Generate your own Client ID and Secret

```bash
node -e "console.log(require('crypto').randomBytes(16).toString('hex'))"
```

Run this twice — one output becomes `OAUTH_CLIENT_ID`, the other
`OAUTH_CLIENT_SECRET`.

### Step 2 — Push this project to GitHub

Push everything except `node_modules` and `.env`. This matters even more if
the repo is public — anything ever committed stays in git history even
after you delete the file later.

### Step 3 — Deploy on Railway

Railway → New Project → Deploy from GitHub repo → select your repo. This
repo has a `Dockerfile` at the root (see Part 3 for why it's no longer
optional), so Railway automatically uses Docker instead of its default
Nixpacks builder.

### Step 4 — Set environment variables

Railway → **Variables** tab:

| Variable | Value | Required? |
|---|---|---|
| `GOOGLE_CLIENT_ID` | from your local `.env` | Yes |
| `GOOGLE_CLIENT_SECRET` | from your local `.env` | Yes |
| `GOOGLE_REFRESH_TOKEN` | from your local `.env` | Yes |
| `DEFAULT_PLAYLIST_NAME` | e.g. `Using Claude AI` | Yes |
| `DEFAULT_RESULT_COUNT` | e.g. `10` | Yes |
| `BASE_URL` | your exact Railway URL, no trailing slash | Yes |
| `OAUTH_CLIENT_ID` | from Step 1 | Yes |
| `OAUTH_CLIENT_SECRET` | from Step 1 | Yes |
| `OPENAI_API_KEY` | from platform.openai.com — see Part 3 | Optional — without it, transcripts skip straight to metadata-only whenever captions fail |
| `ANTHROPIC_API_KEY` | from console.anthropic.com — see Part 4 | Optional — without it, `youtube_smart_search_and_add` falls back to a single plain search |
| `YTDLP_COOKIES_B64` | base64-encoded `cookies.txt` — see Part 5 | Optional but **strongly recommended** — without it, captions and Whisper both fail intermittently due to YouTube's bot detection on cloud IPs |
| `YTDLP_COOKIES_FILE` | `/tmp/cookies.txt` | Required if using `YTDLP_COOKIES_B64` above |
| `WHISPER_MAX_DURATION_SECONDS` | e.g. `10800` for 3 hours | Optional, default 1800 (30 min) — see Part 3 caveats |

Railway sets `PORT` itself — don't add it.

### Step 5 — Add the connector in Claude

1. claude.ai (desktop browser) → **Settings → Connectors → Add custom
   connector**
2. **URL**: `https://your-app.up.railway.app/mcp`
3. Enter the Client ID/Secret from Step 1, click **Connect**, then **Approve**

Connectors are tied to your account, not the device, so this becomes
available on mobile automatically once added.

**Known quirk**: tool-list changes (new tools, schema updates) don't always
propagate to an existing session. If a newly-added tool doesn't show up,
fully disconnect and reconnect the connector — a simple toggle isn't always
enough. In stubborn cases, switching to a genuinely different
client/session (e.g. a brand-new conversation, or a different device
entirely) reliably picks up the current tool list, since each session
negotiates its own tool list independently against the live server.

---

## Part 3 — Transcript pipeline: captions → Whisper → metadata

### The three tiers

1. **YouTube captions** (unofficial, via `youtube-transcript-plus`) — free
   and fast, but breaks if a video has no captions, captions are disabled,
   or — far more often in practice — **YouTube silently blocks the request
   because it's coming from a cloud/datacenter IP** (Railway included).
   This usually doesn't show up as an honest "blocked" error; it shows up as
   a misleading `YoutubeTranscriptNotAvailableError` ("no transcripts are
   available") even on videos that obviously have captions. Treat that
   error message with suspicion, not as ground truth.
2. **Whisper fallback** — if captions fail, downloads audio with `yt-dlp`
   and transcribes via OpenAI's Whisper API. Costs money per call
   ($0.006/minute of audio) and is slower, so it only runs as a fallback.
3. **Metadata-only** — if both fail, you still get title/description/stats
   instead of an outright error.

The `transcriptSource` field in the response tells you which tier actually
ran: `youtube_captions`, `whisper_fallback`, or absent (metadata-only).

### Required Dockerfile contents

The Dockerfile must install, beyond Node itself:
- **`python3`** — required by the Whisper fallback path. Missing this
  fails with a generic `python3: No such file or directory` error that
  gives no hint it's Whisper-related.
- **`ffmpeg`** — for audio extraction
- **`yt-dlp`** — for the actual download
- **`deno`** — yt-dlp needs a JS runtime to execute part of YouTube's page
  JavaScript during extraction; without one configured via yt-dlp's
  `--js-runtimes` flag, downloads fail.

### Known limitations

- **`WHISPER_MAX_DURATION_SECONDS`** caps which videos are even attempted,
  but does **not** prevent a download from timing out on its own for very
  long videos — a multi-hour video can still fail with a `yt-dlp timed out`
  error even with a generous duration cap raised. Treat very long videos as
  unreliable for Whisper regardless of this setting.
- **`transcriptMode: "whisper"`** can be passed to `youtube_summarize_video`
  to force Whisper even when captions would succeed — useful for testing,
  or when you specifically want Whisper's formatting/timestamps over
  captions' raw output (Whisper produces properly punctuated, capitalized
  text with accurate per-segment timestamps; the unofficial captions method
  can return oddly-formatted timing data on some videos).
- Whisper is **not deterministic** — re-transcribing the same video can
  produce minor wording differences run to run.

---

## Part 4 — Smart search: LLM-judged refinement (`youtube_smart_search_and_add`)

### What it does

A plain keyword search can pull badly off-target results — e.g. searching
for a specific corner of a specific racetrack can surface generic
driving-test tutorials that happen to share a few keywords. This tool adds a
judge-and-refine loop on top of `youtube_search_and_add`:

1. Run the search
2. Ask Claude Haiku whether the results actually match your stated `goal`
   (a plain-language description of what counts as relevant — judged on
   **title and channel name only**, not descriptions, transcripts, or
   comments)
3. If fewer than roughly half are relevant, Haiku proposes a better query
   and the loop retries (up to `maxAttempts`, default 3)
4. Once judged "good enough" (or attempts run out), the **whole batch** gets
   added to the playlist — it doesn't filter out individual stragglers from
   an otherwise-acceptable batch

The response includes a `refinementAttempts` array showing every query
tried and Haiku's stated reasoning — useful for sanity-checking *why* it
accepted or rejected a batch, rather than treating it as a black box.

### Cost

Each judgment call is a small Haiku request — title/channel for ~10 results
in, a short JSON verdict out. Realistically a fraction of a cent per
attempt, even at the 3-attempt cap. Negligible next to Whisper costs.

### Known limitation: title/channel-only judgment

The judge currently never sees video descriptions, transcripts, or
comments — only title and channel name. This keeps cost and latency low,
but means judgment quality is bounded by how informative a title happens to
be. Feeding in descriptions (already fetched for free elsewhere in the
codebase via `getVideoDetails`) would meaningfully improve judgment quality
at no extra API cost — a reasonable v2 improvement, not yet implemented.

Pulling in full transcripts or comments for *every* candidate before
judgment was deliberately scoped out — at realistic batch sizes, that could
mean dozens of Whisper calls (potentially $0.30-0.50+ per search) and
multiple minutes of added latency just to filter a search, which defeats
the purpose of a fast pre-filter.

---

## Part 5 — Cookie authentication (captions + yt-dlp bot-detection bypass)

### Why this exists

YouTube increasingly treats requests from cloud-provider IP ranges
(Railway included) with suspicion — independent of whether the code is
correct. This affects **both** the unofficial captions library and
`yt-dlp`. A request that looks like it's coming from a logged-in browser
session gets treated very differently than an anonymous request from a
known datacenter range.

### Setup

1. **Export cookies** from a real, logged-in YouTube session, using a
   "cookies.txt"-style browser extension. Export the **full set** for
   `.youtube.com` and `.google.com` — don't hand-pick individual cookies;
   several work together for session-signing.
2. **Strip `ST-*` cookies** before doing anything else — these are
   disposable per-tab UI/click-tracking state, not authentication, but they
   can be individually 1,000+ characters long and will blow past size
   limits for no benefit:
   ```powershell
   Get-Content "cookies.txt" | Where-Object { ($_ -split "`t")[5] -notlike "ST-*" } | Set-Content "cookies_clean.txt"
   ```
3. **Base64-encode** the cleaned file:
   ```powershell
   [Convert]::ToBase64String([IO.File]::ReadAllBytes("cookies_clean.txt")) | Set-Clipboard
   ```
4. Paste into Railway as `YTDLP_COOKIES_B64`. **Railway env vars cap out at
   32,768 characters** — if you're still over, double-check the `ST-*`
   strip actually ran, since that's almost always the cause.
5. Set `YTDLP_COOKIES_FILE=/tmp/cookies.txt` — `index.js` decodes
   `YTDLP_COOKIES_B64` to that path on every boot.

### Why cookies alone aren't enough for captions

`yt-dlp` handles cookie-based authentication internally and "just works"
once `YTDLP_COOKIES_FILE` is set. The unofficial captions library does not
have built-in cookie support — sending a raw `Cookie` header alone gets
**silently ignored** by YouTube's Innertube API (no error, just treated as
an anonymous request). Getting captions to actually honor the cookies
requires manually computing and attaching a `SAPISIDHASH` Authorization
header (derived from the `SAPISID` cookie, a timestamp, and an Origin
header) — see `transcript-client.js`'s `buildSapisidHash()` for the
implementation. This is undocumented anywhere as a single combined
recipe — it's assembled from how Google's own web Innertube auth works, not
something `youtube-transcript-plus` exposes directly.

### Known failure modes (in the order you'll likely hit them)

1. **Cookie rotation** — Google rotates session cookies as a security
   measure if you keep browsing normally in the same session after
   exporting. **Export from a dedicated browser profile you don't
   otherwise use**, and don't browse YouTube in it again afterward.
2. **CRLF line endings** — if `cookies.txt` was saved/edited on Windows,
   each line likely ends in `\r\n`. Code that only splits on `\n` leaves a
   trailing `\r` stuck on every cookie value, which makes `fetch()`'s
   `Headers` API throw `invalid header value` (it looks like header
   injection). Strip trailing `\r` before parsing.
3. **Even with valid cookies + SAPISIDHASH, captions can still fail** —
   YouTube may be layering additional anti-bot measures (e.g. proof-of-origin
   tokens) on top of session auth. Treat cookies as raising the success
   rate, not as a guaranteed fix. Whisper remains the reliable fallback.

### Security note

`cookies.txt` contains live authentication for a real Google account —
treat it like a password. Never commit it to the repo, never paste it
anywhere besides Railway's Variables tab, and be aware it can carry
browsing-context fragments (e.g. recent search terms, video IDs), not just
login tokens.

---

## Known rough edges (current as of mid-2026)

- **Tool-list propagation**: see the note in Part 2 — newly added tools
  sometimes need a full disconnect/reconnect, or a fresh session entirely,
  to show up.
- **Generic tool-execution errors** (`"Error occurred during tool
  execution"` with no detail) are sometimes transient — a bare retry
  resolves them more often than not. If a retry doesn't help, check
  whether *every* tool fails the same way (points to a connector/session
  issue) versus just one (points to a code issue in that specific tool).
- Connector OAuth quirks (missing `WWW-Authenticate` header, `.well-known`
  metadata path variants) — see original troubleshooting table below,
  still applicable.

## Troubleshooting

**"FATAL: BASE_URL is not set"** — add it in Railway Variables, exact
public URL, no trailing slash.

**"FATAL: OAUTH_CLIENT_ID / OAUTH_CLIENT_SECRET are not set"** — add both
in Railway Variables.

**Claude says "Unknown client_id"** — the Client ID typed into Claude's
connector form doesn't match `OAUTH_CLIENT_ID` in Railway. Re-copy
carefully.

**"Missing YouTube credentials" in logs** — `GOOGLE_REFRESH_TOKEN` wasn't
copied correctly into Railway's Variables tab.

**Whisper fallback always fails** — confirm `OPENAI_API_KEY` is set in
Railway. Then check logs: a `yt-dlp` download error usually means bot
detection (see Part 5) or a timeout on a very long video; an OpenAI API
error means the key itself or quota.

**Captions fail with "video is no longer available" or "no transcripts
available," even on videos that obviously have captions** — almost always
bot detection, not a real captions problem. See Part 5.

**`SyntaxError` after editing a file by hand** — almost always a brace
mismatch from a partial paste. Run `node --check yourfile.js` locally
before redeploying; it catches this in under a second instead of waiting
for a full Railway build to fail.

**Build fails on Railway after Dockerfile changes** — check build logs
around `apt-get install`/`curl` steps; a transient network blip during
image build is the most common cause, and retriggering the deploy usually
resolves it.
