/**
 * Transcript fetching via an UNOFFICIAL method (youtube-transcript-plus),
 * since the official YouTube Data API cannot fetch transcripts for videos
 * this account doesn't own. This is fundamentally less reliable than the
 * rest of this server: no SLA, can break on YouTube changes, and may be
 * rate-limited/blocked depending on the deployment's IP range.
 *
 * Every function here is designed to fail soft — callers should always be
 * able to fall back to metadata-only summarization if this throws.
 */
import { fetchTranscript } from 'youtube-transcript-plus';
import fs from 'node:fs';
import { createHash } from 'node:crypto';

/**
 * Builds a raw `Cookie:` header string from the same cookies.txt this
 * server already decodes for yt-dlp (see YTDLP_COOKIES_FILE / index.js).
 * Reusing it here means the captions path benefits from the same
 * "looks like a real logged-in browser" signal, with no new cookie
 * export/rotation process to maintain.
 *
 * Fails soft: returns null if the file is missing or unreadable, so
 * callers can fall back to an uncookied request rather than throwing.
 */
function loadCookieHeader() {
  const cookiesPath = process.env.YTDLP_COOKIES_FILE;
  if (!cookiesPath) return null;
  try {
    const raw = fs.readFileSync(cookiesPath, 'utf-8');
    return raw
      .split('\n')
      .filter(line => line.trim() && !line.startsWith('#'))
      .map(line => {
        const parts = line.split('\t');
        return `${parts[5]}=${parts[6]}`;
      })
      .filter(pair => pair && !pair.startsWith('undefined'))
      .join('; ');
  } catch (err) {
    console.error(`[transcript-client] could not read cookies file for captions request: ${err.message}`);
    return null;
  }
}

/**
 * Pulls a single named cookie's value out of a `name=value; name=value`
 * style cookie header string. Used to grab SAPISID specifically, since
 * that's the one needed to compute the auth hash below.
 */
function extractCookieValue(cookieHeader, name) {
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match ? match[1] : null;
}

/**
 * Generates the `Authorization: SAPISIDHASH <ts>_<hash>` header Google's
 * Innertube API requires to actually trust a cookie as an authenticated
 * session, rather than silently treating the request as anonymous (which
 * is what happens if you send cookies alone, with no error — exactly the
 * failure mode this was added to fix). Algorithm: sha1("<unix_ts> <SAPISID> <origin>").
 */
function buildSapisidHash(cookieHeader, origin) {
  const sapisid = extractCookieValue(cookieHeader, 'SAPISID') || extractCookieValue(cookieHeader, '__Secure-3PAPISID');
  if (!sapisid) return null;
  const timestamp = Math.floor(Date.now() / 1000);
  const hash = createHash('sha1').update(`${timestamp} ${sapisid} ${origin}`).digest('hex');
  return `SAPISIDHASH ${timestamp}_${hash}`;
}

/**
 * Fetches a transcript and groups it into timestamped chunks, so long
 * videos (multi-hour podcasts) produce a structured, navigable result
 * instead of one giant wall of text. Chunk boundaries are approximate —
 * we just accumulate segments until we cross chunkSeconds, then start a
 * new chunk.
 */
export async function getChunkedTranscript(videoId, chunkSeconds = 600) {
  try {
    const cookieHeader = loadCookieHeader();
    const origin = 'https://www.youtube.com';
    const authHeader = cookieHeader ? buildSapisidHash(cookieHeader, origin) : null;

    const fetchOptions = cookieHeader
      ? {
          videoFetch: async ({ url, lang, userAgent }) =>
            fetch(url, { headers: { ...(lang && { 'Accept-Language': lang }), 'User-Agent': userAgent, Cookie: cookieHeader } }),
          playerFetch: async ({ url, method, body, headers, lang, userAgent }) =>
            fetch(url, {
              method,
              headers: {
                ...(lang && { 'Accept-Language': lang }),
                'User-Agent': userAgent,
                Cookie: cookieHeader,
                ...(authHeader && { Authorization: authHeader, 'X-Origin': origin }),
                ...headers,
              },
              body,
            }),
          transcriptFetch: async ({ url, lang, userAgent }) =>
            fetch(url, { headers: { ...(lang && { 'Accept-Language': lang }), 'User-Agent': userAgent, Cookie: cookieHeader } }),
        }
      : undefined;

    const segments = await fetchTranscript(videoId, fetchOptions);
    return chunkSegments(segments, chunkSeconds);
  } catch (err) {
    console.error(`[transcript-client] captions fetch failed for ${videoId}: name=${err.name} message=${err.message || String(err)}`);
    throw err;
  }
}

/**
 * Groups a flat array of {offset, duration, text} segments (offset/duration
 * in SECONDS — this matches youtube-transcript-plus's native units, see
 * https://www.npmjs.com/package/youtube-transcript-plus) into timestamped
 * chunks. Factored out of getChunkedTranscript() so the Whisper fallback
 * (whisper-fallback.js) can produce identically-shaped output from a
 * completely different segment source (OpenAI's API instead of
 * youtube-transcript-plus, which also natively uses seconds), letting
 * callers treat both transcript sources interchangeably.
 */
export function chunkSegments(segments, chunkSeconds = 600) {
  if (!segments.length) {
    return { chunks: [], totalWords: 0, totalDurationSeconds: 0 };
  }

  const chunks = [];
  let current = { startSeconds: 0, text: [] };

  for (const seg of segments) {
    const segStart = seg.offset;
    if (segStart - current.startSeconds >= chunkSeconds && current.text.length) {
      chunks.push(finalizeChunk(current));
      current = { startSeconds: segStart, text: [] };
    }
    current.text.push(seg.text);
  }
  if (current.text.length) chunks.push(finalizeChunk(current));

  const totalWords = chunks.reduce((sum, c) => sum + c.wordCount, 0);
  const lastSeg = segments[segments.length - 1];
  const totalDurationSeconds = lastSeg.offset + (lastSeg.duration || 0);

  return { chunks, totalWords, totalDurationSeconds };
}

function finalizeChunk(current) {
  const text = current.text.join(' ').replace(/\s+/g, ' ').trim();
  return {
    startSeconds: Math.floor(current.startSeconds),
    startFormatted: formatSeconds(current.startSeconds),
    text,
    wordCount: text.split(/\s+/).filter(Boolean).length
  };
}

function formatSeconds(totalSeconds) {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = Math.floor(totalSeconds % 60);
  const parts = h > 0 ? [h, m, s] : [m, s];
  return parts.map((p, i) => (i === 0 ? String(p) : String(p).padStart(2, '0'))).join(':');
}

/** Named error classes from youtube-transcript-plus we want to handle specially. */
export function classifyTranscriptError(err) {
  if (err.name === 'YoutubeTranscriptTooManyRequestError') return 'rate_limited';
  if (err.name === 'YoutubeTranscriptDisabledError') return 'disabled';
  if (err.name === 'YoutubeTranscriptNotAvailableError') return 'not_available';
  return 'unknown';
}
