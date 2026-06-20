/**
 * Whisper-based transcript fallback, used only when the unofficial
 * youtube-transcript-plus method (transcript-client.js) fails — disabled
 * captions, rate limiting, etc. This downloads the video's audio with
 * yt-dlp and sends it to OpenAI's Whisper API for transcription.
 *
 * This path is slower and costs money per call (OpenAI bills per minute
 * of audio), so it's only ever attempted as a fallback, never primary.
 * It also depends on two things being present in the deployment that
 * are NOT npm packages — they're installed in the Dockerfile instead:
 *   - the `yt-dlp` binary (downloads + extracts audio)
 *   - ffmpeg (yt-dlp shells out to it for audio extraction/conversion)
 *
 * KNOWN RISK: YouTube increasingly bot-detects downloads coming from
 * cloud-provider IP ranges (Railway included) and may block yt-dlp
 * entirely for some videos even though this code is otherwise correct.
 * If that happens consistently, set YTDLP_COOKIES_FILE to the path of a
 * cookies.txt exported from a real logged-in browser session — yt-dlp
 * will use it to look like an authenticated browser request.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chunkSegments } from './transcript-client.js';

const execFileAsync = promisify(execFile);

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
// whisper-1 is the only OpenAI transcription model that currently supports
// verbose_json + segment-level timestamps, which we need for chunking.
const WHISPER_MODEL = process.env.WHISPER_MODEL || 'whisper-1';
const MAX_AUDIO_BYTES = 25 * 1024 * 1024; // OpenAI's hard per-file upload limit
// Cloud audio download + transcription of multi-hour videos is slow and
// expensive; cap it by default and let the deployment raise this deliberately.
const MAX_DURATION_SECONDS = parseInt(process.env.WHISPER_MAX_DURATION_SECONDS || '1800', 10);
// How long the yt-dlp child process itself is allowed to run before Node
// kills it. This is separate from MAX_DURATION_SECONDS above — that cap
// decides whether a download is attempted at all (based on the video's
// length); this one decides how long the actual download is allowed to
// take once it's running, which scales with network speed and video
// length and can genuinely exceed a short default on long videos.
const DOWNLOAD_TIMEOUT_MS = parseInt(process.env.WHISPER_DOWNLOAD_TIMEOUT_MS || '1200000', 10); // 20 min default

export function whisperFallbackAvailable() {
  return Boolean(OPENAI_API_KEY);
}

/**
 * Downloads just the audio track for a video into a fresh temp directory,
 * as a low-bitrate mp3 to maximize the chance of staying under OpenAI's
 * 25MB upload limit. Returns the file path plus a cleanup fn — callers
 * MUST call cleanup() when done, whether the rest of the pipeline
 * succeeds or fails, since Railway's filesystem is ephemeral but not
 * automatically swept between requests within a running instance.
 */
async function downloadAudio(videoId) {
  console.error(`[whisper-fallback] starting audio download for video ${videoId} (max ${MAX_DURATION_SECONDS}s)`);
  const dir = await mkdtemp(path.join(tmpdir(), `yt-audio-${videoId}-`));
  const outputTemplate = path.join(dir, 'audio.%(ext)s');

  const args = [
    '-x',
    '--audio-format', 'mp3',
    // q:a 8 ~= 85kbps VBR. NOTE: q:a 5 (the previous setting) is actually
    // ~130kbps, not ~64kbps as originally assumed here — at that bitrate,
    // anything over ~26 min exceeds OpenAI's 25MB limit even though it's
    // well inside the 30-min MAX_DURATION_SECONDS default, wasting a full
    // download before failing on size. q:a 8 keeps a full 30-min video
    // comfortably under 19MB instead.
    '--audio-quality', '8',
    '--match-filter', `duration <= ${MAX_DURATION_SECONDS}`,
    '--no-playlist',
    '-o', outputTemplate
  ];
  if (process.env.YTDLP_COOKIES_FILE) {
    args.push('--cookies', process.env.YTDLP_COOKIES_FILE);
  }
  args.push(`https://www.youtube.com/watch?v=${videoId}`);

  let stdout = '', stderr = '';
  try {
    const result = await execFileAsync('yt-dlp', args, {
      maxBuffer: 1024 * 1024 * 10,
      timeout: DOWNLOAD_TIMEOUT_MS
    });
    stdout = result.stdout;
    stderr = result.stderr;
  } catch (err) {
    await rm(dir, { recursive: true, force: true });
    if (err.killed) {
      console.error(`[whisper-fallback] yt-dlp timed out after ${DOWNLOAD_TIMEOUT_MS}ms for video ${videoId}`);
      throw new Error(
        `yt-dlp timed out after ${Math.round(DOWNLOAD_TIMEOUT_MS / 1000)}s downloading audio ` +
        `(set WHISPER_DOWNLOAD_TIMEOUT_MS to raise it, or the video may be too long for synchronous processing).`
      );
    }
    if (/does not pass filter/i.test(err.stderr || '')) {
      console.error(`[whisper-fallback] video ${videoId} exceeds duration cap (${MAX_DURATION_SECONDS}s)`);
      throw new Error(
        `Video exceeds the ${MAX_DURATION_SECONDS}s duration cap for Whisper fallback ` +
        `(set WHISPER_MAX_DURATION_SECONDS to raise it).`
      );
    }
    console.error(`[whisper-fallback] yt-dlp failed for video ${videoId}: ${(err.stderr || err.message || '').slice(0, 1000)}`);
    throw new Error(`yt-dlp failed to download audio: ${(err.stderr || err.message || '').slice(0, 500)}`);
  }

  if (/does not pass filter/i.test(stdout + stderr)) {
    await rm(dir, { recursive: true, force: true });
    console.error(`[whisper-fallback] video ${videoId} exceeds duration cap (${MAX_DURATION_SECONDS}s)`);
    throw new Error(
      `Video exceeds the ${MAX_DURATION_SECONDS}s duration cap for Whisper fallback ` +
      `(set WHISPER_MAX_DURATION_SECONDS to raise it).`
    );
  }

  const filePath = path.join(dir, 'audio.mp3');
  const { size } = await stat(filePath).catch(() => ({ size: 0 }));
  if (!size) {
    await rm(dir, { recursive: true, force: true });
    console.error(`[whisper-fallback] yt-dlp produced no audio file for video ${videoId}. stdout: ${stdout.slice(0, 500)} stderr: ${stderr.slice(0, 500)}`);
    throw new Error('yt-dlp reported success but produced no audio file — the video may be unavailable or blocked.');
  }
  if (size > MAX_AUDIO_BYTES) {
    await rm(dir, { recursive: true, force: true });
    console.error(`[whisper-fallback] audio for video ${videoId} is ${(size / 1024 / 1024).toFixed(1)}MB, over the 25MB limit`);
    throw new Error(
      `Extracted audio is ${(size / 1024 / 1024).toFixed(1)}MB, over OpenAI's 25MB limit. ` +
      `Try a shorter video, or lower WHISPER_MAX_DURATION_SECONDS so long videos get rejected earlier.`
    );
  }

  console.error(`[whisper-fallback] downloaded audio for video ${videoId}: ${(size / 1024 / 1024).toFixed(2)}MB`);

  return {
    filePath,
    cleanup: () => rm(dir, { recursive: true, force: true })
  };
}

/**
 * Sends the audio file to OpenAI's Whisper API and asks for segment-level
 * timestamps, so the result can be chunked the same way as captions.
 * Uses Node's built-in fetch/FormData/Blob (stable since Node 18+) rather
 * than adding the `openai` SDK or `node-fetch` as a dependency.
 */
async function transcribeAudio(filePath) {
  if (!OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is not set — Whisper fallback is unavailable.');
  }

  const buffer = await readFile(filePath);
  console.error(`[whisper-fallback] sending ${(buffer.length / 1024 / 1024).toFixed(2)}MB to OpenAI (model=${WHISPER_MODEL})`);

  const form = new FormData();
  form.append('file', new Blob([buffer], { type: 'audio/mpeg' }), 'audio.mp3');
  form.append('model', WHISPER_MODEL);
  form.append('response_format', 'verbose_json');
  form.append('timestamp_granularities[]', 'segment');

  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: form
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    console.error(`[whisper-fallback] OpenAI Whisper API error (${res.status}): ${errText.slice(0, 1000)}`);
    throw new Error(`OpenAI Whisper API error (${res.status}): ${errText.slice(0, 500)}`);
  }

  console.error('[whisper-fallback] OpenAI transcription succeeded');
  return res.json(); // { text, segments: [{ start, end, text, ... }], ... }
}

/**
 * Full fallback pipeline: download audio -> transcribe -> chunk into the
 * exact same shape getChunkedTranscript() produces (transcript-client.js),
 * so callers in youtube-tools.js can treat both transcript sources
 * identically downstream.
 */
export async function getChunkedTranscriptViaWhisper(videoId, chunkSeconds = 600) {
  const { filePath, cleanup } = await downloadAudio(videoId);
  try {
    const result = await transcribeAudio(filePath);
    const segments = (result.segments || []).map(seg => ({
      offset: seg.start * 1000,
      duration: Math.max(0, (seg.end - seg.start)) * 1000,
      text: seg.text
    }));
    console.error(`[whisper-fallback] video ${videoId} done — ${segments.length} segments`);
    return chunkSegments(segments, chunkSeconds);
  } finally {
    await cleanup().catch(err => console.error(`[whisper-fallback] cleanup failed for video ${videoId}: ${err.message}`));
  }
}
