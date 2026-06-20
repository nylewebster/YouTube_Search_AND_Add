/**
 * Tool definitions and call handler, shared between the local stdio server
 * and the remote HTTP server. Keeping this in one place means the YouTube
 * logic only needs to be correct once.
 */
import { YouTubeClient } from './youtube-client.js';
import { getChunkedTranscript, classifyTranscriptError } from './transcript-client.js';
import { getChunkedTranscriptViaWhisper, whisperFallbackAvailable } from './whisper-fallback.js';

const DEFAULT_PLAYLIST_NAME = process.env.DEFAULT_PLAYLIST_NAME || 'Using Claude AI';
const DEFAULT_RESULT_COUNT = parseInt(process.env.DEFAULT_RESULT_COUNT || '10', 10);

export function createYouTubeClient() {
  return new YouTubeClient({
    clientId: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    refreshToken: process.env.GOOGLE_REFRESH_TOKEN
  });
}

export const toolDefinitions = [
  {
    name: 'youtube_search_and_add',
    description:
      `Search YouTube for videos and automatically add the top results to a playlist. ` +
      `This is the main "do everything" tool — use it whenever the user wants to find videos ` +
      `on a topic and have them added to a playlist in one step. Defaults to the top ` +
      `${DEFAULT_RESULT_COUNT} results and the "${DEFAULT_PLAYLIST_NAME}" playlist if not specified.`,
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'YouTube search query' },
        count: {
          type: 'integer',
          description: `Number of top results to add (default ${DEFAULT_RESULT_COUNT})`
        },
        playlistName: {
          type: 'string',
          description: `Playlist name to add to (default "${DEFAULT_PLAYLIST_NAME}")`
        },
        order: {
          type: 'string',
          enum: ['relevance', 'date', 'viewCount', 'rating'],
          description: 'Sort order for search results (default relevance)'
        },
        skipDuplicates: {
          type: 'boolean',
          description: 'Skip videos already in the playlist (default true)'
        }
      },
      required: ['query']
    }
  },
  {
    name: 'youtube_search',
    description:
      'Search YouTube for videos without adding anything. Use this when the user wants to ' +
      'browse or review options before deciding what to add.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'YouTube search query' },
        count: { type: 'integer', description: 'Number of results (default 10)' },
        order: {
          type: 'string',
          enum: ['relevance', 'date', 'viewCount', 'rating']
        }
      },
      required: ['query']
    }
  },
  {
    name: 'youtube_add_videos',
    description:
      'Add specific YouTube video IDs to a playlist. Use this after youtube_search when the ' +
      'user has told you which specific videos (from the search results) they want added.',
    inputSchema: {
      type: 'object',
      properties: {
        videoIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'YouTube video IDs to add'
        },
        playlistName: { type: 'string', description: 'Target playlist name' },
        skipDuplicates: { type: 'boolean' }
      },
      required: ['videoIds']
    }
  },
  {
    name: 'youtube_list_playlists',
    description: "List the user's YouTube playlists with item counts and privacy status.",
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'youtube_summarize_video',
    description:
      'Get a summary of a video. By default, attempts to fetch the actual spoken transcript ' +
      '(chunked into timestamped sections) so you can produce a real content summary, not just ' +
      'metadata — this matters most for long-form videos (podcasts, streams, lectures) where the ' +
      'description doesn\'t capture what\'s actually said. Transcript fetching has two tiers: first ' +
      'an UNOFFICIAL captions method (the official YouTube API can\'t fetch transcripts for videos ' +
      'this account doesn\'t own), and if that fails, an OpenAI Whisper fallback that downloads the ' +
      'audio and transcribes it directly — slower and costs money per call, so it only runs when ' +
      'captions aren\'t available. If both fail, this tool falls back to a metadata-only summary ' +
      '(title/description/stats) and tells you that happened. Identify the video either by ' +
      'videoId directly, or by playlistName + position (e.g. "the first video in my Guilty Gear ' +
      'playlist" -> playlistName + position=1).',
    inputSchema: {
      type: 'object',
      properties: {
        videoId: { type: 'string', description: 'YouTube video ID to summarize' },
        playlistName: {
          type: 'string',
          description: 'Playlist to pull the video from, if not specifying videoId directly'
        },
        position: {
          type: 'integer',
          description: '1-based position within the playlist (1 = first video). Used with playlistName.'
        },
        includeTranscript: {
          type: 'boolean',
          description: 'Attempt to fetch the real transcript (default true). Set false to skip straight to metadata-only.'
        },
        chunkMinutes: {
          type: 'integer',
          description: 'Length of each timestamped transcript chunk in minutes (default 10). Smaller chunks = more granular but more chunks to read.'
        },
        allowWhisperFallback: {
          type: 'boolean',
          description: 'If unofficial captions fail, fall back to downloading audio and transcribing it with OpenAI Whisper (default true). This costs money and is slower — set false to skip straight to metadata-only on caption failure.'
        },
        transcriptMode: {
          type: 'string',
          enum: ['auto', 'whisper'],
          description: '"auto" (default): try YouTube captions first, fall back to Whisper only if they fail. "whisper": skip the captions attempt entirely and force Whisper transcription, regardless of whether captions are available. Useful for testing the Whisper path deliberately, or when you specifically want Whisper\'s transcription over YouTube\'s auto-captions.'
        }
      },
      required: []
    }
  },
  {
    name: 'youtube_create_playlist',
    description: 'Create a new YouTube playlist.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        description: { type: 'string' },
        privacy: { type: 'string', enum: ['private', 'unlisted', 'public'] }
      },
      required: ['title']
    }
  }
];

async function resolvePlaylistId(yt, name) {
  const targetName = name || DEFAULT_PLAYLIST_NAME;
  const playlist = await yt.findPlaylistByName(targetName);
  if (!playlist) {
    throw new Error(
      `No playlist found matching "${targetName}". Use youtube_list_playlists to see available playlists, ` +
      `or youtube_create_playlist to make a new one.`
    );
  }
  return playlist;
}

/** Executes a tool call. Returns the MCP `content` array, or throws. */
export async function handleToolCall(yt, name, args) {
  switch (name) {
    case 'youtube_search_and_add': {
      const count = args.count || DEFAULT_RESULT_COUNT;
      const results = await yt.search(args.query, count, args.order || 'relevance');
      const playlist = await resolvePlaylistId(yt, args.playlistName);
      const { results: addResults, summary } = await yt.addVideosToPlaylist(
        playlist.id,
        results.map(r => r.videoId),
        { skipDuplicates: args.skipDuplicates !== false }
      );
      const enriched = results.map(r => ({
        ...r,
        status: addResults.find(a => a.videoId === r.videoId)?.status
      }));
      return [{
        type: 'text',
        text: JSON.stringify({ playlist: playlist.title, query: args.query, summary, videos: enriched }, null, 2)
      }];
    }

    case 'youtube_search': {
      const results = await yt.search(args.query, args.count || 10, args.order || 'relevance');
      return [{ type: 'text', text: JSON.stringify(results, null, 2) }];
    }

    case 'youtube_add_videos': {
      const playlist = await resolvePlaylistId(yt, args.playlistName);
      const { results, summary } = await yt.addVideosToPlaylist(
        playlist.id,
        args.videoIds,
        { skipDuplicates: args.skipDuplicates !== false }
      );
      return [{ type: 'text', text: JSON.stringify({ playlist: playlist.title, summary, results }, null, 2) }];
    }

    case 'youtube_list_playlists': {
      const playlists = await yt.listPlaylists();
      return [{ type: 'text', text: JSON.stringify(playlists, null, 2) }];
    }

    case 'youtube_summarize_video': {
      let videoId = args.videoId;
      let playlistContext = null;

      if (!videoId) {
        if (!args.playlistName) {
          throw new Error('Provide either videoId, or playlistName (with optional position).');
        }
        const playlist = await resolvePlaylistId(yt, args.playlistName);
        const items = await yt.getPlaylistItems(playlist.id);
        if (!items.length) {
          throw new Error(`Playlist "${playlist.title}" has no videos.`);
        }
        const pos = (args.position || 1) - 1; // 1-based -> 0-based
        const item = items[pos];
        if (!item) {
          throw new Error(`Playlist "${playlist.title}" has ${items.length} video(s); position ${args.position} is out of range.`);
        }
        videoId = item.videoId;
        playlistContext = { playlistTitle: playlist.title, position: pos + 1, totalItems: items.length };
      }

      const details = await yt.getVideoDetails(videoId);
      const wantsTranscript = args.includeTranscript !== false;
      const chunkSeconds = (args.chunkMinutes || 10) * 60;

      let transcriptResult = null;
      let transcriptError = null;
      let transcriptSource = null;

      if (wantsTranscript && args.transcriptMode === 'whisper') {
        if (!whisperFallbackAvailable()) {
          transcriptError = {
            classification: 'whisper_unavailable',
            message: 'transcriptMode is "whisper" but OPENAI_API_KEY is not set on the server.'
          };
        } else {
          console.error(`[youtube_summarize_video] transcriptMode=whisper for ${videoId}, skipping captions entirely`);
          try {
            const { chunks, totalWords, totalDurationSeconds } = await getChunkedTranscriptViaWhisper(videoId, chunkSeconds);
            transcriptResult = { chunks, totalWords, totalDurationSeconds, chunkCount: chunks.length };
            transcriptSource = 'whisper_fallback';
          } catch (whisperErr) {
            console.error(`[youtube_summarize_video] forced Whisper failed for ${videoId}: ${whisperErr.message}`);
            transcriptError = { classification: 'whisper_failed', message: whisperErr.message || String(whisperErr) };
          }
        }
      } else if (wantsTranscript) {
        try {
          const { chunks, totalWords, totalDurationSeconds } = await getChunkedTranscript(videoId, chunkSeconds);
          transcriptResult = { chunks, totalWords, totalDurationSeconds, chunkCount: chunks.length };
          transcriptSource = 'youtube_captions';
        } catch (err) {
          transcriptError = {
            classification: classifyTranscriptError(err),
            message: err.message || String(err)
          };

          const allowWhisper = args.allowWhisperFallback !== false;
          if (allowWhisper && whisperFallbackAvailable()) {
            console.error(`[youtube_summarize_video] captions failed for ${videoId} (${transcriptError.classification}), trying Whisper fallback`);
            try {
              const { chunks, totalWords, totalDurationSeconds } = await getChunkedTranscriptViaWhisper(videoId, chunkSeconds);
              transcriptResult = { chunks, totalWords, totalDurationSeconds, chunkCount: chunks.length };
              transcriptSource = 'whisper_fallback';
            } catch (whisperErr) {
              console.error(`[youtube_summarize_video] Whisper fallback failed for ${videoId}: ${whisperErr.message}`);
              transcriptError.whisperFallback = { message: whisperErr.message || String(whisperErr) };
            }
          } else if (allowWhisper) {
            console.error(`[youtube_summarize_video] captions failed for ${videoId} and Whisper fallback is unavailable (no OPENAI_API_KEY)`);
            transcriptError.whisperFallback = { message: 'OPENAI_API_KEY not set on the server — Whisper fallback unavailable.' };
          }
        }
      }

      const base = {
        ...details,
        durationFormatted: formatIsoDuration(details.duration),
        description: truncateDescription(details.description),
        playlistContext
      };

      if (transcriptResult) {
        const note = transcriptSource === 'whisper_fallback'
          ? 'Captions were unavailable, so this transcript was generated by downloading the audio and ' +
            'transcribing it with OpenAI Whisper. The "chunks" array reflects what Whisper heard, not ' +
            'official captions — treat it as a best-effort approximation (names, jargon, and ' +
            'non-English speech are the most common error spots), not a verbatim transcript.'
          : 'Transcript fetched successfully via an unofficial method (not the official YouTube API). ' +
            'The "chunks" array contains the actual spoken content broken into timestamped sections — ' +
            'use this to produce a real content summary covering what was actually said, not just metadata. ' +
            'For long videos, consider summarizing chunk-by-chunk or grouping related chunks together.';

        return [{
          type: 'text',
          text: JSON.stringify({
            ...base,
            transcriptAvailable: true,
            transcriptSource,
            transcript: transcriptResult,
            note
          }, null, 2)
        }];
      }

      // Fell back to metadata-only — captions failed, and either Whisper wasn't
      // attempted, wasn't available, or also failed.
      return [{
        type: 'text',
        text: JSON.stringify({
          ...base,
          transcriptAvailable: false,
          transcriptError: transcriptError,
          caveat: wantsTranscript
            ? `Transcript fetch failed (${transcriptError?.classification || 'unknown'}: ${transcriptError?.message || 'no details'})` +
              `${transcriptError?.whisperFallback ? `; Whisper fallback also failed (${transcriptError.whisperFallback.message})` : ''}, ` +
              `so this summary is metadata-only (title/description/stats). It does not reflect spoken ` +
              `content beyond what's in the description.`
            : `Transcript fetch was skipped (includeTranscript=false). This summary is metadata-only.`
        }, null, 2)
      }];
    }

    case 'youtube_create_playlist': {
      const playlist = await yt.createPlaylist(args.title, args.description || '', args.privacy || 'private');
      return [{ type: 'text', text: JSON.stringify(playlist, null, 2) }];
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

/** Converts YouTube's ISO 8601 duration (e.g. "PT32M32S") to "32:32". */
function formatIsoDuration(iso) {
  const match = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return iso;
  const [, h, m, s] = match;
  const hh = parseInt(h || '0', 10);
  const mm = parseInt(m || '0', 10);
  const ss = parseInt(s || '0', 10);
  const parts = hh > 0 ? [hh, mm, ss] : [mm, ss];
  return parts.map((p, i) => (i === 0 ? String(p) : String(p).padStart(2, '0'))).join(':');
}

/** Keeps descriptions from blowing up the response; full text is rarely needed. */
function truncateDescription(desc, maxLen = 1500) {
  if (desc.length <= maxLen) return desc;
  return desc.slice(0, maxLen) + '… [truncated]';
}
