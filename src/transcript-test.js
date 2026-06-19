/**
 * Isolated, diagnostic-heavy test for whether transcript scraping actually
 * works from this server's deployment environment (Railway). Deliberately
 * kept separate from youtube-tools.js / youtube-client.js — if this fails
 * or breaks, it should not affect any of the 6 working tools.
 *
 * This uses youtube-transcript-plus, an UNOFFICIAL method that mimics what
 * YouTube's web player does internally. It is not the official Data API
 * and may be blocked by YouTube depending on the server's IP range.
 */
import { fetchTranscript } from 'youtube-transcript-plus';

export const transcriptTestToolDefinition = {
  name: 'youtube_test_transcript_fetch',
  description:
    'DIAGNOSTIC TOOL — tests whether transcript fetching works at all from this ' +
    'server\'s current deployment environment. Uses an unofficial method (not the ' +
    'official YouTube API), so this may fail even for videos that have captions, ' +
    'if YouTube is blocking requests from this server\'s network. Returns detailed ' +
    'success/failure info rather than a polished summary — this is purely to ' +
    'validate the approach before building real functionality on top of it.',
  inputSchema: {
    type: 'object',
    properties: {
      videoId: { type: 'string', description: 'YouTube video ID to test transcript fetch on' }
    },
    required: ['videoId']
  }
};

export async function handleTranscriptTest(args) {
  const { videoId } = args;
  const startedAt = Date.now();

  try {
    const transcript = await fetchTranscript(videoId);
    const elapsedMs = Date.now() - startedAt;

    const segmentCount = transcript.length;
    const totalText = transcript.map(seg => seg.text).join(' ');
    const wordCount = totalText.split(/\s+/).filter(Boolean).length;
    const lastSegment = transcript[transcript.length - 1];
    const approxDurationSeconds = lastSegment ? lastSegment.offset / 1000 + (lastSegment.duration || 0) / 1000 : null;

    return [{
      type: 'text',
      text: JSON.stringify({
        success: true,
        videoId,
        elapsedMs,
        segmentCount,
        wordCount,
        approxDurationSeconds,
        firstSegments: transcript.slice(0, 5),
        note: 'Fetch succeeded. This confirms transcript scraping works from this server\'s current network/IP. ' +
              'Full transcript text omitted from this response for brevity — only first 5 segments shown.'
      }, null, 2)
    }];
  } catch (err) {
    const elapsedMs = Date.now() - startedAt;
    return [{
      type: 'text',
      text: JSON.stringify({
        success: false,
        videoId,
        elapsedMs,
        errorName: err.name || null,
        errorMessage: err.message || String(err),
        note: 'Fetch failed. This could mean: (1) the video has no captions at all, ' +
              '(2) YouTube is blocking requests from this server\'s IP range (common for cloud hosts ' +
              'like Railway), or (3) youtube-transcript-plus needs an update for a recent YouTube change. ' +
              'Try a different, well-known video with confirmed captions to rule out cause (1).'
      }, null, 2)
    }];
  }
}
