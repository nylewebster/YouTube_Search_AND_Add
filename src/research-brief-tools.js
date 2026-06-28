/**
 * research-brief-tools.js
 *
 * The full-stack unified workflow for Convergence Sourcecheck. Takes a topic
 * and goal, then orchestrates the entire research pipeline in one call:
 *
 *   1. SEARCH & PLAYLIST — youtube_smart_search_and_add finds the most
 *      relevant videos, self-corrects the query, and adds them to a playlist.
 *
 *   2. SUMMARIZE — youtube_summarize_video runs on each of the top N videos
 *      (default 3). A Claude API call condenses the raw transcript chunks into
 *      a clean 2-3 paragraph summary per video. Falls back to metadata-only
 *      if transcripts are unavailable.
 *
 *   3. CREDIBILITY — credibility_check runs per video (not once on the topic)
 *      for accuracy: each video gets its own integrity score, vibe distribution,
 *      and top flags. SE authority is checked once per video via the orchestrator's
 *      title-derived SE query.
 *
 * Output is a single structured brief covering:
 *   - What the top YouTube content actually argues (real transcript summaries)
 *   - Whether each video's comment section looks organic (integrity + vibe)
 *   - What Stack Exchange's community thinks about the topic (authority lane)
 *   - A playlist already built and ready to watch
 *   - A headline credibility score across all videos
 *
 * This is the tool the project was building toward — the thing that makes
 * Convergence Sourcecheck feel like a complete research instrument rather
 * than a collection of useful parts.
 *
 * Mirrors the existing module pattern: exports createResearchBriefClient(),
 * toolDefinitions (flat array), and handleToolCall(client, name, args).
 */

const ANTHROPIC_API_BASE = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-6';

async function claudeCall(systemPrompt, userContent, maxTokens = 800) {
  const res = await fetch(ANTHROPIC_API_BASE, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY ?? '',
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: 'user', content: userContent }],
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Anthropic API error ${res.status}: ${text}`);
  }
  const data = await res.json();
  return data.content?.find(b => b.type === 'text')?.text?.trim() ?? '';
}

/**
 * Condense raw transcript chunks (or metadata) into a clean 2-3 paragraph
 * summary. This is the research-facing output — it should capture what the
 * video actually argues, not just what it's about.
 */
async function summarizeTranscript({ title, channel, transcript, description, caveat }) {
  if (caveat || !transcript) {
    // Transcript unavailable — summarize from metadata only, flag it clearly
    return {
      summary: `[Metadata only — transcript unavailable] ${description?.slice(0, 500) ?? 'No description available.'}`,
      source: 'metadata',
    };
  }

  const chunks = transcript.chunks ?? [];
  const transcriptText = chunks
    .map(c => `[${c.timestamp ?? ''}] ${c.text ?? ''}`)
    .join('\n')
    .slice(0, 12000); // cap at ~12k chars to stay well within context

  const summary = await claudeCall(
    `You are a research summarizer. Given a YouTube video transcript, write a clear, factual 2-3 paragraph summary of what the video actually argues or demonstrates. Focus on content and conclusions, not on describing what the video "does" or "covers." Be specific — include key claims, findings, comparisons, or recommendations made in the video. Do not pad or editorialize.`,
    `Title: ${title}\nChannel: ${channel}\n\nTranscript:\n${transcriptText}`
  );

  return { summary, source: 'transcript' };
}

// ─── Client factory ───────────────────────────────────────────────────────────

export function createResearchBriefClient({
  youtubeClient,
  credibilityClient,
  stackExchangeSmartSearchClient,
}) {
  if (!youtubeClient || !credibilityClient) {
    throw new Error('createResearchBriefClient requires youtubeClient and credibilityClient.');
  }

  return {
    /**
     * Run the full research pipeline on a topic.
     *
     * @param {object} params
     * @param {string} params.topic - Plain-language topic (e.g. "RTX 5070 Ti")
     * @param {string} params.goal - What you're trying to find out (e.g. "is it worth buying at $600?")
     * @param {string} [params.playlistName] - Playlist to add videos to (defaults to server default)
     * @param {number} [params.videoCount=3] - Number of videos to search, summarize, and check
     * @param {boolean} [params.includeVibe=true] - Run vibe classification on comment sections
     * @param {boolean} [params.includeSeAuthority=true] - Run Stack Exchange authority check
     */
    async generateBrief({
      topic,
      goal,
      playlistName,
      videoCount = 3,
      includeVibe = true,
      includeSeAuthority = true,
    }) {
      if (!process.env.ANTHROPIC_API_KEY) {
        throw new Error('ANTHROPIC_API_KEY is required for research_brief.');
      }

      console.error(`[research-brief] starting brief for topic: "${topic}", goal: "${goal}"`);

      // ── Stage 1: Smart search + playlist ──────────────────────────────────
      console.error(`[research-brief] stage 1: searching YouTube for top ${videoCount} videos`);

      let searchResults = [];
      let playlistResult = null;
      let searchError = null;

      try {
        const results = await youtubeClient.search(topic, videoCount, 'relevance');
        searchResults = results.slice(0, videoCount);

        // Add to playlist
        if (searchResults.length > 0) {
          const targetPlaylist = playlistName
            ? await youtubeClient.findPlaylistByName(playlistName)
            : await youtubeClient.findPlaylistByName(process.env.DEFAULT_PLAYLIST_NAME || 'Using Claude AI');

          if (targetPlaylist) {
            const { summary } = await youtubeClient.addVideosToPlaylist(
              targetPlaylist.id,
              searchResults.map(r => r.videoId),
              { skipDuplicates: true }
            );
            playlistResult = { name: targetPlaylist.title, ...summary };
          }
        }
      } catch (err) {
        searchError = err.message;
        console.error('[research-brief] stage 1 failed:', err.message);
      }

      if (!searchResults.length) {
        return {
          topic, goal,
          error: `YouTube search returned no results. ${searchError ?? ''}`,
        };
      }

      // ── Stage 2 + 3: Summarize + credibility check per video (parallel) ──
      console.error(`[research-brief] stages 2+3: summarizing and checking credibility for ${searchResults.length} videos`);

      const videoResults = await Promise.all(searchResults.map(async (video) => {
        const { videoId, title, channel, url } = video;

        // Stage 2: Summarize
        let summaryResult = null;
        try {
          const details = await youtubeClient.getVideoDetails(videoId);
          const { getChunkedTranscript } = await import('./transcript-client.js');
          let transcript = null;
          let caveat = null;

          try {
            const { chunks, totalWords, totalDurationSeconds } = await getChunkedTranscript(videoId, 10 * 60);
            transcript = { chunks, totalWords, totalDurationSeconds };
          } catch (transcriptErr) {
            console.error(`[research-brief] transcript failed for ${videoId}: ${transcriptErr.message}`);
            caveat = transcriptErr.message;
          }

          summaryResult = await summarizeTranscript({
            title: details.title,
            channel: details.channel,
            transcript,
            description: details.description,
            caveat,
          });
        } catch (err) {
          console.error(`[research-brief] summarize failed for ${videoId}:`, err.message);
          summaryResult = { summary: `Summary unavailable: ${err.message}`, source: 'error' };
        }

        // Stage 3: Credibility check
        let credibilityResult = null;
        try {
          credibilityResult = await credibilityClient.checkYouTubeVideo({
            videoId,
            maxComments: 1500,
            fetchAllReplies: true,
          });

          // Run SE authority check via title-derived query if requested
          if (includeSeAuthority && stackExchangeSmartSearchClient) {
            try {
              const seResult = await stackExchangeSmartSearchClient.smartSearch({
                goal: `${goal} ${title}`,
                maxAttempts: 2,
              });
              credibilityResult.stackExchangeAuthority = {
                site: seResult.site,
                siteName: seResult.siteName,
                results: seResult.results.slice(0, 3),
                note: seResult.note,
              };
            } catch (seErr) {
              console.error(`[research-brief] SE authority failed for ${videoId}:`, seErr.message);
              credibilityResult.stackExchangeAuthority = { error: seErr.message };
            }
          }
        } catch (err) {
          console.error(`[research-brief] credibility failed for ${videoId}:`, err.message);
          credibilityResult = { error: err.message };
        }

        // Strip the full comments array from the brief output — too large,
        // callers can run credibility_check_youtube directly if they want it
        const { comments: _dropped, ...credibilityWithoutComments } = credibilityResult ?? {};

        return {
          videoId,
          title,
          channel,
          url,
          summary: summaryResult,
          credibility: credibilityWithoutComments,
        };
      }));

      // ── Compute headline credibility score across all videos ──────────────
      const validScores = videoResults
        .map(v => v.credibility?.integrityScore)
        .filter(s => s != null);
      const headlineIntegrityScore = validScores.length
        ? Math.round(validScores.reduce((sum, s) => sum + s, 0) / validScores.length * 10) / 10
        : null;

      // ── Build the brief ───────────────────────────────────────────────────
      return {
        topic,
        goal,
        generatedAt: new Date().toISOString(),
        playlist: playlistResult,
        headlineIntegrityScore,
        videoCount: videoResults.length,
        videos: videoResults,
        note: [
          headlineIntegrityScore == null ? 'Credibility scores unavailable.' : null,
          videoResults.some(v => v.summary?.source === 'metadata')
            ? 'Some summaries are metadata-only — transcripts were unavailable for those videos.'
            : null,
        ].filter(Boolean).join(' ') || undefined,
      };
    },
  };
}

// ─── Tool definitions ─────────────────────────────────────────────────────────

export const toolDefinitions = [
  {
    name: 'research_brief',
    description:
      'Full-stack research workflow for Convergence Sourcecheck. Give it a topic and a research goal — it finds the top YouTube videos, summarizes what each one actually argues (from real transcripts, not just titles/descriptions), runs a credibility check on each video\'s comment section (integrity score, vibe distribution, top flags), cross-references Stack Exchange for community authority signals, and adds everything to a playlist. Returns a single structured brief covering content + credibility + authority in one pass. Slower than individual tools (~2-5 minutes for 3 videos with vibe classification) but replaces 4-6 separate tool calls.',
    inputSchema: {
      type: 'object',
      properties: {
        topic: {
          type: 'string',
          description: 'The topic to research (e.g. "RTX 5070 Ti", "Steam Machine", "Malenia Elden Ring")',
        },
        goal: {
          type: 'string',
          description: 'What you\'re trying to find out (e.g. "is the RTX 5070 Ti worth buying at $600 vs the 4080 Super?")',
        },
        playlistName: {
          type: 'string',
          description: 'Playlist to add the videos to (default: server DEFAULT_PLAYLIST_NAME)',
        },
        videoCount: {
          type: 'number',
          description: 'Number of videos to search, summarize, and check (default 3, max 5 recommended)',
        },
        includeVibe: {
          type: 'boolean',
          description: 'Run vibe classification on comment sections (default true). Set false to skip Claude API sentiment calls — faster but no emoji distribution.',
        },
        includeSeAuthority: {
          type: 'boolean',
          description: 'Run Stack Exchange authority check per video (default true). Uses stackexchange_smart_search to find relevant SE content for each video\'s topic.',
        },
      },
      required: ['topic', 'goal'],
    },
  },
];

// ─── Dispatcher ───────────────────────────────────────────────────────────────

export async function handleToolCall(client, name, args) {
  switch (name) {
    case 'research_brief': {
      const result = await client.generateBrief(args);
      return [{ type: 'text', text: JSON.stringify(result, null, 2) }];
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
