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

/**
 * Fetches a transcript and groups it into timestamped chunks, so long
 * videos (multi-hour podcasts) produce a structured, navigable result
 * instead of one giant wall of text. Chunk boundaries are approximate —
 * we just accumulate segments until we cross chunkSeconds, then start a
 * new chunk.
 */
export async function getChunkedTranscript(videoId, chunkSeconds = 600) {
  try {
    const segments = await fetchTranscript(videoId);
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
