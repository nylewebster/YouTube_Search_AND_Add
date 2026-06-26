# YouTube Search & Add — MCP Server

A self-hosted MCP (Model Context Protocol) server, deployed on Railway, that connects Claude to the YouTube Data API, OpenAI's Whisper API, the Stack Exchange API, and the Anthropic API. Built as a personal tool — not commercialized, and not intended for production/commercial scale (see [Scope](#scope--why-this-isnt-commercial)).

Repo: [github.com/nylewebster/YouTube_Search_AND_Add](https://github.com/nylewebster/YouTube_Search_AND_Add)

---

## What it does

Connects Claude to YouTube, Stack Exchange, and the Anthropic API via a custom OAuth connector, exposing tools for search, playlist management, transcription, Q&A research, and source credibility checking — all callable directly from a Claude conversation.

## Tools

### YouTube (8)

| Tool | Purpose |
|---|---|
| `youtube_search` | Search YouTube without adding anything |
| `youtube_search_and_add` | Search and auto-add top results to a playlist |
| `youtube_smart_search_and_add` | Same, with an LLM-judged refinement loop for better relevance |
| `youtube_add_videos` | Add specific video IDs to a playlist |
| `youtube_create_playlist` | Create a new playlist |
| `youtube_list_playlists` | List playlists with item counts and privacy status |
| `youtube_get_comments` | Get top-level comments for a video (quick sentiment use case) |
| `youtube_summarize_video` | Summarize a video (captions if available, Whisper fallback otherwise) |

### Stack Exchange (3)

| Tool | Purpose |
|---|---|
| `stackexchange_search` | Search questions by free-text query and/or tags on a given site |
| `stackexchange_get_answers` | Get the full answer thread for a question ID, sorted by votes |
| `stackexchange_list_sites` | List available Stack Exchange network sites |

### Credibility (3)

| Tool | Purpose |
|---|---|
| `credibility_check_youtube` | Integrity-lane check on a video's comment section: bot-likelihood heuristics across a paginated sample including full reply chains |
| `credibility_check_stackexchange` | Authority-lane check on a Stack Exchange answer thread: vote score, accepted status, and reputation combined into a 0–100 score per answer |
| `credibility_check` | **Top-level orchestrator.** Takes a YouTube URL or topic string and runs both lanes automatically, returning a unified readout with headline score, vibe distribution, and top flags |

---

## Credibility tools — design and scoring model

The credibility system is built around a two-lane model (inspired by rtings.com's approach of showing both a headline number and the sub-scores behind it):

### Authority lane (Stack Exchange)
Scores answer threads using the platform's own trust signals: vote score, accepted-answer status, and answerer reputation. Reputation acts as a *modifier* (±15%) rather than an independent point source — a high-rep author nudges an already-good answer up slightly, but can't carry an answer the community hasn't endorsed. Scores are log-scaled to avoid saturation on high-traffic threads. A freshness floor is applied to zero-vote answers so a brand-new answer isn't penalized the same as an old, unvoted one.

### Integrity lane (YouTube)
Scores comment sections using converging bot-likelihood heuristics via a noisy-OR combination model — weak signals barely move the score alone, but multiple signals converging compound quickly:

| Heuristic | Signal | Max weight |
|---|---|---|
| Duplicate-text clustering | Near-identical text from multiple *distinct* accounts | ~0.75 at large cluster sizes |
| Generic-phrase match | Short context-free praise ("great video", "first") | 0.12 — deliberately weak |
| Spam/self-promo pattern | URLs, "check my channel", "DM me" | 0.40 |
| Posting-burst timing | Dense comment clusters vs. the video's all-time median pace | up to 0.50 |

**Known false-positive modes (confirmed on real data):**
- Creator links in pinned correction notes trigger the URL/spam flag (0.4) — the flag surfaces `reason: 'url_or_spam'` in the output so consumers can apply appropriate skepticism
- Many distinct humans independently posting the same short reaction on a controversial video triggers the duplicate-text flag — `distinctAuthors` is surfaced per flagged cluster so "2 bot accounts" vs "29 real humans saying the same thing" is immediately distinguishable
- Burst timing fires on any dense minute relative to the all-time median, including notification-squad activity right after upload — not just coordinated bot behavior. This is a documented limitation; a rolling recent-window baseline would be more precise but isn't implemented yet.

Account age is intentionally absent from the integrity lane — it would require a `channels.list` call per unique commenter (quota cost scales with comment volume) and is a deferred cost decision.

### Vibe distribution
The `credibility_check` orchestrator also classifies comment sentiment in batches of 50 using the Claude API, producing a per-platform distribution across six buckets:

| Bucket | Meaning |
|---|---|
| 😊 | Positive — genuine praise, excitement, gratitude |
| 😐 | Neutral — questions, observations, comparisons |
| 😡 | Negative — criticism, anger, disappointment |
| 😂 | Humorous — jokes, puns, genuinely funny one-liners |
| 🙃 | Sarcastic — dry humor, irony, backhanded praise |
| 🤖 | Suspicious — comments where bot-probability ≥ 0.5 (applied by the orchestrator from the integrity lane, not by the sentiment classifier) |

🤖 is deliberately independent of sentiment — a suspicious comment still gets a sentiment classification. Per-platform distributions are shown separately; an optional combined view is available when multiple videos are checked.

### Orchestrator (`credibility_check`)
Takes a YouTube URL or topic string and routes automatically:
- **YouTube URL:** integrity check on that specific video + SE authority search derived from the video title via a Claude API call (avoids naive string-stripping failures on click-bait-style titles)
- **Topic string:** integrity check on the top 3 YouTube search results + SE authority search on the topic

Returns: headline score (asterisked if only one lane produced a result), per-platform lane scores, vibe distributions, and a `topFlags` summary of the highest bot-probability comments with flag reasons — so consumers don't need to dig through the full annotated comment array.

---

## Account architecture — read this before touching auth

This is the most important section in this doc. The server uses **two separate Google accounts with two separate risk profiles**, and that separation is intentional.

### OAuth / playlist account — the main account, now on Google Workspace

- **Used for:** all YouTube Data API calls — playlist operations, comment fetching, video metadata, search, and the credibility tools' comment-fetching pipeline.
- **Auth:** OAuth 2.0 with a refresh token. The project's Google Cloud project lives under `tornyle@nylewebster.com` (a Google Workspace Standard account), with the OAuth consent screen set to **Internal** — which means refresh tokens do not expire on the 7-day clock that affects External/Testing apps. This was a deliberate migration: the original project lived under a personal Gmail account, which silently expired the refresh token weekly.
- **Why Internal matters:** Internal apps skip Google's verification process entirely, have no test-user cap, and most importantly don't expire refresh tokens. The tradeoff is that only accounts within the `nylewebster.com` Workspace org can authorize — which is fine for a personal tool.
- **If the refresh token ever breaks again:** run `npm run auth` locally from the repo root. It opens a browser to Google's consent screen, captures the auth code automatically, and writes a fresh `.env` with the new `GOOGLE_REFRESH_TOKEN`. Copy the new value to Railway and redeploy.

### Cookie account — disposable, expect periodic bans

- **Used for:** `yt-dlp` audio downloads, which feed the Whisper fallback transcription pipeline (used only when official YouTube captions aren't available).
- **Why it's risky:** `yt-dlp` has to present an authenticated session cookie to get past YouTube's bot detection when requesting from a datacenter IP (Railway). That combination — automated request pattern + non-residential IP + session cookie — is exactly the fingerprint YouTube's anti-bot systems are built to flag.
- **Status:** currently a throwaway account, deliberately not tied to any real identity. Treat a ban here as a "when," not an "if."
- **Cookie export notes:**
  - Export via a **private/incognito window**, not a normal signed-in tab — YouTube rotates cookies on open authenticated tabs as a security measure, which can silently invalidate a cookie exported the normal way.
  - To check which account a stale cookie belongs to without risking rotation, check `accounts.google.com` directly — do **not** open a YouTube tab just to check.
  - When the cookie does die, re-export from a fresh private window and redeploy the env var on Railway.

---

## Whisper fallback pipeline

Used only when official captions aren't available for a video.

1. `yt-dlp` downloads audio (cookie-account auth, see above)
2. Audio is sent to OpenAI's Whisper API for transcription
3. Transcript feeds into `youtube_summarize_video`

**Known bugs fixed during development:**
- `yt-dlp` binary type mismatch
- Deno JavaScript runtime requirement not satisfied
- Download timeout on longer videos
- Audio bitrate / file size limits exceeded
- Missing error logging on pipeline failures
- Milliseconds-vs-seconds chunking bug in transcript timestamps

**Recommended instrumentation:** log how often `transcriptSource` resolves to `whisper_fallback` vs. `captions` — this determines actual real-world exposure to the cookie-ban risk above. If most target content already has captions, the fallback (and its risk) may be firing less often than assumed.

---

## Stack Exchange integration

Three tools covering search, answer threads, and site listing across the full Stack Exchange network (Stack Overflow, Skeptics, Meta, Arqade, and ~90 others). Uses a Stack Apps API key for a 10,000 requests/day quota (vs. 300/day/IP without a key).

**Fixed issue:** `stackexchange_list_sites` initially threw a `400 bad_parameter` error due to an invalid/stale `filter` value. Resolved by removing the custom filter and using the `withbody` built-in constant instead.

---

## Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `GOOGLE_CLIENT_ID` | Yes | OAuth client ID for the YouTube Data API |
| `GOOGLE_CLIENT_SECRET` | Yes | OAuth client secret |
| `GOOGLE_REFRESH_TOKEN` | Yes | Long-lived refresh token (run `npm run auth` to generate) |
| `OAUTH_CLIENT_ID` | Yes | Client ID for Claude's MCP connector OAuth flow |
| `OAUTH_CLIENT_SECRET` | Yes | Client secret for Claude's MCP connector OAuth flow |
| `BASE_URL` | Yes | Public Railway URL (e.g. `https://youtubesearchandadd-production.up.railway.app`) |
| `ANTHROPIC_API_KEY` | Yes | Used by vibe classifier and smart search refinement loop |
| `OPENAI_API_KEY` | No | Enables Whisper fallback transcription — without it, `youtube_summarize_video` falls back to metadata-only when captions are unavailable |
| `STACKEXCHANGE_API_KEY` | No | 10,000 requests/day quota instead of 300/day/IP — register free at stackapps.com |
| `YTDLP_COOKIES_B64` | No | Base64-encoded YouTube session cookie for `yt-dlp` (cookie account) |
| `DEFAULT_PLAYLIST_NAME` | No | Default playlist for `youtube_search_and_add` (default: "Using Claude AI") |
| `DEFAULT_RESULT_COUNT` | No | Default result count for search tools (default: 10) |

---

## Deployment

- Hosted on Railway, auto-deploys on push to `main`.
- Connected to Claude via a custom OAuth connector (self-rolled in `oauth.js` — not Google OAuth; that's separate).
- Past deployment issues worth remembering if debugging recurs:
  - Railway deployment sync quirks (live server vs. Claude's session tool-list cache going out of sync) — **fix: start a fresh Claude conversation** after deploying a new tool, since existing sessions cache the old `tools/list` response
  - MCP session tool-list propagation delays after deploys

---

## Roadmap / in progress

- **Reddit integration:** `reddit_client.js` designed; Data API approval request submitted, pending approval at time of writing. Will face the same "paid API access" economics as Stack Exchange's commercial tiers at scale — factor into scope decisions once approved. The credibility orchestrator already has a graceful `unsupported_url` path for Reddit URLs that surfaces a clear message rather than silently failing.
- **Vibe classifier improvements:** the burst-timing heuristic uses an all-time median baseline across the full comment history, meaning it fires on *any* momentary density spike rather than specifically detecting coordinated upload-day activity. A rolling recent-window median would make the behavior match the name more closely — documented as a known limitation in `credibility-tools.js`.
- **Account age signal for integrity lane:** currently absent because it requires a `channels.list` call per unique commenter. Worth adding if quota budget allows — would meaningfully improve the integrity score's signal quality on small comment sections where burst-timing and phrase-clustering produce thin evidence.
- **SE topic extraction for non-technical videos:** the orchestrator uses Claude to derive a Stack Exchange query from a video's title and description, which handles click-bait titles well. For entertainment/lifestyle content with no SE-relevant topic, it correctly returns null and skips the SE lane — but the headline score is then asterisked as single-lane. A future improvement could fall back to a broader knowledge-base search rather than SE specifically for these cases.
- **PO Token migration (considered, not implemented):** would reduce — not eliminate — single-account dependency for the Whisper pipeline. Adds a sidecar provider process to operate, and YouTube's SABR streaming changes mean cookies are often still required alongside PO tokens for some content anyway. Not yet worth the added operational complexity for a personal-scale tool.

---

## Scope — why this isn't commercial

Commercialization was explored and deliberately ruled out:
- Reddit's API requires paid commercial tiers past a certain volume.
- YouTube's bot detection makes audio-download-at-scale an active cat-and-mouse problem, not a stable foundation to build a product on.
- Running this at "commercially viable" scale would mean drawing exactly the kind of attention the cookie-account architecture above is designed to absorb quietly at low, personal-use volume.

The credibility tools in particular are designed as a **research-transparency tool** — useful to the kind of person doing source evaluation, quick due diligence, or sanity-checking a comment section before trusting it. That's a real, if not lucrative, audience. But the heuristic-only model (no IP/device/behavioral data) means accuracy has a real ceiling, and the tool is explicitly framed as triage rather than verdict.

This is, and is intended to remain, a personal tool.
