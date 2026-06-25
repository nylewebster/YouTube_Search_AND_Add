# YouTube Search & Add — MCP Server

A self-hosted MCP (Model Context Protocol) server, deployed on Railway, that connects Claude to the YouTube Data API, OpenAI's Whisper API, and the Stack Exchange API. Built as a personal tool — not commercialized, and not intended for production/commercial scale (see [Scope](#scope--why-this-isnt-commercial)).

Repo: [github.com/nylewebster/YouTube_Search_AND_Add](https://github.com/nylewebster/YouTube_Search_AND_Add)

---

## What it does

Connects Claude to YouTube and Stack Exchange via a custom OAuth connector, exposing tools for search, playlist management, transcription, and Q&A research — all callable directly from a Claude conversation.

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
| `youtube_get_comments` | Get top-level comments for a video |
| `youtube_summarize_video` | Summarize a video (captions if available, Whisper fallback otherwise) |

### Stack Exchange (3)

| Tool | Purpose |
|---|---|
| `stackexchange_search` | Search questions by free-text query and/or tags on a given site |
| `stackexchange_get_answers` | Get the full answer thread for a question ID, sorted by votes |
| `stackexchange_list_sites` | List available Stack Exchange network sites |

---

## Account architecture — read this before touching auth

This is the most important section in this doc. The server uses **two separate Google accounts with two separate risk profiles**, and that separation is intentional:

### Cookie account — disposable, expect periodic bans

- **Used for:** `yt-dlp` audio downloads, which feed the Whisper fallback transcription pipeline (used only when official YouTube captions aren't available).
- **Why it's risky:** `yt-dlp` has to present an authenticated session cookie to get past YouTube's bot detection when requesting from a datacenter IP (Railway). That combination — automated request pattern + non-residential IP + session cookie — is exactly the fingerprint YouTube's anti-bot systems are built to flag.
- **Status:** currently a throwaway account, deliberately not tied to any real identity. Treat a ban here as a "when," not an "if."
- **Cookie export notes:**
  - Export via a **private/incognito window**, not a normal signed-in tab — YouTube rotates cookies on open authenticated tabs as a security measure, which can silently invalidate a cookie exported the normal way.
  - To check which account a stale cookie belongs to without risking rotation, check `accounts.google.com` directly — do **not** open a YouTube tab just to check.
  - When the cookie does die, re-export from a fresh private window and redeploy the env var on Railway.

### OAuth / playlist account — safe, keep this as your real identity

- **Used for:** all playlist operations (`youtube_create_playlist`, `youtube_add_videos`, `youtube_list_playlists`, `youtube_search_and_add`), via the official YouTube Data API with OAuth.
- **Why it's safe:** this is a sanctioned, rate-limited, quota-metered API path that Google's own developer ecosystem is built around — not a scraping pattern. Risk here is "exceeded quota" or "violated content policy," not "flagged as a bot."
- **Action item:** confirm this is a *different* account from the cookie account. If they're currently the same account, a ban on the cookie side takes the playlist side down with it. Splitting them is the single highest-leverage fix available.

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

Added after the YouTube tools were stable. Three tools covering search, answer threads, and site listing across the full Stack Exchange network (Stack Overflow, Skeptics, Meta, Arqade, and ~90 others).

**Fixed issue:** `stackexchange_list_sites` initially threw a `400 bad_parameter` error due to an invalid/stale `filter` value being passed to the Stack Exchange `/sites` endpoint. Resolved by correcting the filter parameter.

---

## Deployment

- Hosted on Railway.
- Connected to Claude via a custom OAuth connector.
- Past deployment issues worth remembering if debugging recurs:
  - Railway deployment sync quirks (live server vs. Claude's session tool-list cache going out of sync)
  - MCP session tool-list propagation delays after deploys

---

## Roadmap / in progress

- **Reddit integration:** `reddit_client.js` designed; Data API approval request submitted, pending approval at time of writing. Will face the same "paid API access" economics as Stack Exchange's commercial tiers — factor into scope decisions once approved.
- **Bot-likelihood scoring for `youtube_get_comments`:** discussed but not yet built. Planned approach: timing-since-publish (free, already have both timestamps), duplicate-phrase clustering (free, post-fetch), account age (costs an extra `channels.list` call per unique commenter). Cross-video behavior tracking would need its own persistent datastore (e.g. Postgres on Railway) since YouTube's API doesn't expose a "comments by this account across videos" endpoint.
- **PO Token migration (considered, not implemented):** would reduce — not eliminate — single-account dependency for the Whisper pipeline. Adds a sidecar provider process to operate, and YouTube's SABR streaming changes mean cookies are often still required alongside PO tokens for some content anyway. Documented in detail in project notes; not yet worth the added operational complexity for a personal-scale tool.

---

## Scope — why this isn't commercial

Commercialization was explored and deliberately ruled out:
- Reddit's API requires paid commercial tiers past a certain volume.
- YouTube's bot detection makes audio-download-at-scale an active-cat-and-mouse problem, not a stable foundation to build a product on.
- Running this at "commercially viable" scale would mean drawing exactly the kind of attention the cookie-account architecture above is designed to absorb quietly at low, personal-use volume.

This is, and is intended to remain, a personal tool.
