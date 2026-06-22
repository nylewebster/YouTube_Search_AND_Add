/**
 * Thin wrapper around the YouTube Data API v3.
 * Handles silent access-token refresh using the stored refresh token,
 * so callers never have to think about auth.
 */

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API_BASE = 'https://www.googleapis.com/youtube/v3';

export class YouTubeClient {
  constructor({ clientId, clientSecret, refreshToken }) {
    if (!clientId || !clientSecret || !refreshToken) {
      throw new Error(
        'Missing YouTube credentials. Run `npm run auth` first to authorize this server.'
      );
    }
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.refreshToken = refreshToken;
    this.accessToken = null;
    this.accessTokenExpiry = 0; // epoch ms
  }

  async _ensureAccessToken() {
    if (this.accessToken && Date.now() < this.accessTokenExpiry - 30_000) {
      return this.accessToken;
    }
    const body = new URLSearchParams({
      client_id: this.clientId,
      client_secret: this.clientSecret,
      refresh_token: this.refreshToken,
      grant_type: 'refresh_token'
    });
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString()
    });
    const data = await res.json();
    if (!data.access_token) {
      throw new Error(
        `Failed to refresh access token: ${data.error_description || data.error || 'unknown error'}`
      );
    }
    this.accessToken = data.access_token;
    this.accessTokenExpiry = Date.now() + (data.expires_in || 3600) * 1000;
    return this.accessToken;
  }

  async _get(path, params) {
    const token = await this._ensureAccessToken();
    const url = new URL(`${API_BASE}/${path}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const data = await res.json();
    if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
    return data;
  }

  async _post(path, params, body) {
    const token = await this._ensureAccessToken();
    const url = new URL(`${API_BASE}/${path}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
    return data;
  }

  /** Search YouTube for videos. Returns a simplified list. */
  async search(query, maxResults = 10, order = 'relevance') {
    const data = await this._get('search', {
      part: 'snippet',
      q: query,
      type: 'video',
      maxResults: Math.min(Math.max(maxResults, 1), 50),
      order
    });
    return (data.items || []).map(item => ({
      videoId: item.id.videoId,
      title: item.snippet.title,
      channel: item.snippet.channelTitle,
      publishedAt: item.snippet.publishedAt,
      thumbnail: item.snippet.thumbnails?.medium?.url || item.snippet.thumbnails?.default?.url || null,
      url: `https://youtu.be/${item.id.videoId}`
    }));
  }

  /** List the authenticated user's playlists. */
  async listPlaylists() {
    const data = await this._get('playlists', {
      part: 'snippet,status,contentDetails',
      mine: true,
      maxResults: 50
    });
    return (data.items || []).map(p => ({
      id: p.id,
      title: p.snippet.title,
      itemCount: p.contentDetails?.itemCount ?? null,
      privacy: p.status?.privacyStatus ?? null
    }));
  }

  /** Find a playlist by exact or fuzzy (case-insensitive substring) name match. */
  async findPlaylistByName(name) {
    const playlists = await this.listPlaylists();
    const lower = name.toLowerCase();
    return (
      playlists.find(p => p.title.toLowerCase() === lower) ||
      playlists.find(p => p.title.toLowerCase().includes(lower)) ||
      null
    );
  }

  /**
   * Get playlist items in playlist order (position 0 = first video added,
   * NOT necessarily "added first chronologically" if items were reordered
   * in the YouTube UI — position reflects current playlist order).
   */
  async getPlaylistItems(playlistId, maxResults = 50) {
    const data = await this._get('playlistItems', {
      part: 'snippet,contentDetails',
      playlistId,
      maxResults
    });
    return (data.items || [])
      .sort((a, b) => (a.snippet.position ?? 0) - (b.snippet.position ?? 0))
      .map(item => ({
        videoId: item.contentDetails.videoId,
        title: item.snippet.title,
        position: item.snippet.position
      }));
  }

  /**
   * Full video details useful for a metadata-based summary: title,
   * description, channel, duration, view count, tags. This does NOT
   * include a transcript — the official API can't fetch transcripts for
   * videos you don't own (see youtube-tools.js for the explanation surfaced
   * to the user).
   */
  async getVideoDetails(videoId) {
    const data = await this._get('videos', {
      part: 'snippet,contentDetails,statistics',
      id: videoId
    });
    const item = data.items?.[0];
    if (!item) throw new Error(`No video found with ID ${videoId}`);
    return {
      videoId,
      title: item.snippet.title,
      channel: item.snippet.channelTitle,
      description: item.snippet.description || '',
      publishedAt: item.snippet.publishedAt,
      tags: item.snippet.tags || [],
      duration: item.contentDetails.duration, // ISO 8601, e.g. PT32M32S
      viewCount: item.statistics?.viewCount ?? null,
      likeCount: item.statistics?.likeCount ?? null,
      url: `https://youtu.be/${videoId}`
    };
  }

  /**
   * Get top-level comments for a video. Note: this only returns top-level
   * comments, not nested replies — fetching full reply threads would need
   * a separate call per comment via the `replies` part, which isn't worth
   * the extra API quota unless a caller specifically needs it.
   */
  async getVideoComments(videoId, maxResults = 20, order = 'relevance') {
    const data = await this._get('commentThreads', {
      part: 'snippet',
      videoId,
      maxResults: Math.min(Math.max(maxResults, 1), 100),
      order, // 'relevance' (YouTube's "top comments") or 'time' (newest first)
      textFormat: 'plainText'
    });
    return (data.items || []).map(item => {
      const top = item.snippet.topLevelComment.snippet;
      return {
        author: top.authorDisplayName,
        text: top.textDisplay,
        likeCount: top.likeCount,
        publishedAt: top.publishedAt,
        replyCount: item.snippet.totalReplyCount
      };
    });
  }

  /** Create a new playlist. */
  async createPlaylist(title, description = '', privacyStatus = 'private') {
    const data = await this._post('playlists', { part: 'snippet,status' }, {
      snippet: { title, description },
      status: { privacyStatus }
    });
    return { id: data.id, title: data.snippet.title, privacy: data.status.privacyStatus };
  }

  /** Add a single video to a playlist. */
  async addVideoToPlaylist(playlistId, videoId) {
    const data = await this._post('playlistItems', { part: 'snippet' }, {
      snippet: {
        playlistId,
        resourceId: { kind: 'youtube#video', videoId }
      }
    });
    return { playlistItemId: data.id, videoId };
  }

  /** Get existing video IDs in a playlist (for duplicate-skip logic). */
  async getPlaylistVideoIds(playlistId) {
    const ids = new Set();
    let pageToken;
    do {
      const data = await this._get('playlistItems', {
        part: 'contentDetails',
        playlistId,
        maxResults: 50,
        ...(pageToken ? { pageToken } : {})
      });
      for (const item of data.items || []) {
        if (item.contentDetails?.videoId) ids.add(item.contentDetails.videoId);
      }
      pageToken = data.nextPageToken;
    } while (pageToken);
    return ids;
  }

  /**
   * Add multiple videos to a playlist, skipping ones already present.
   * Returns a per-video result list plus summary counts.
   */
  async addVideosToPlaylist(playlistId, videoIds, { skipDuplicates = true } = {}) {
    const existing = skipDuplicates ? await this.getPlaylistVideoIds(playlistId) : new Set();
    const results = [];
    for (const videoId of videoIds) {
      if (existing.has(videoId)) {
        results.push({ videoId, status: 'skipped', reason: 'already in playlist' });
        continue;
      }
      try {
        await this.addVideoToPlaylist(playlistId, videoId);
        results.push({ videoId, status: 'added' });
      } catch (err) {
        results.push({ videoId, status: 'error', reason: err.message });
      }
      await new Promise(r => setTimeout(r, 250)); // gentle pacing, mirrors the original tool
    }
    const summary = {
      added: results.filter(r => r.status === 'added').length,
      skipped: results.filter(r => r.status === 'skipped').length,
      failed: results.filter(r => r.status === 'error').length
    };
    return { results, summary };
  }
}
