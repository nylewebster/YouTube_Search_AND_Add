/**
 * Tool definitions and call handler, shared between the local stdio server
 * and the remote HTTP server. Keeping this in one place means the YouTube
 * logic only needs to be correct once.
 */
import { YouTubeClient } from './youtube-client.js';

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

    case 'youtube_create_playlist': {
      const playlist = await yt.createPlaylist(args.title, args.description || '', args.privacy || 'private');
      return [{ type: 'text', text: JSON.stringify(playlist, null, 2) }];
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
