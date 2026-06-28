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

import { classifyCommentVibes, buildVibeDistribution, BATCH_SIZE as VIBE_BATCH_SIZE } from './vibe-classifier.js';

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

// ─── Brief config presets (A/B knobs) ─────────────────────────────────────────
// These bundle the cost/quality levers that affect a brief into named presets
// so they can be A/B tested in the field. Every brief echoes its resolved
// config back in the output (`config` on generateBrief's return) and the viewer
// labels it, so two briefs run under different presets are distinguishable at a
// glance and you can decide which you prefer from real results.
//
// Modules the presets toggle:
//   - vibe         : run comment-sentiment classification (emoji distribution).
//                    Adds a Claude API call per ~50 comments. Off = scores only.
//   - commentDepth : how many comments to sample per video for integrity + vibe.
//                    Deeper = more accurate, more cost/latency.
// Keep keys in sync with BRIEF_PRESETS in credibility-viewer/src/api.js.
export const VIBE_PRESETS = {
  full: { label: 'Full — vibe on, deep sample', includeVibe: true,  maxComments: 1500 },
  lite: { label: 'Lite — vibe on, shallow sample', includeVibe: true, maxComments: 500 },
  off:  { label: 'Off — no vibe, deep sample', includeVibe: false, maxComments: 1500 },
};

export const DEFAULT_VIBE_MODE = 'full';

// Rough vibe-classification cost model. Vibe runs on Sonnet 4.6 ($3/MTok in,
// $15/MTok out) in batches of VIBE_BATCH_SIZE comments; each batch is ~3k input
// + ~200 output tokens ≈ $0.012. These estimates are deliberately approximate
// (real token counts vary with comment length) — they exist so the A/B presets
// can be compared on real spend in the field, not billed to the cent.
const VIBE_COST_PER_BATCH_USD = 0.012;

function estimateVibeCostUsd(commentCount) {
  const batches = Math.ceil((commentCount || 0) / VIBE_BATCH_SIZE);
  return Math.round(batches * VIBE_COST_PER_BATCH_USD * 100) / 100;
}

// Build the labeled, per-module config breakdown attached to every brief. This
// is the explicit "what does this modularity change" surface for A/B review.
// vibeCommentsClassified / videosChecked come from the finished run, so the cost
// figures reflect what this brief actually spent — not a worst-case guess.
function buildBriefConfig({
  vibeMode, includeVibe, maxComments, resolvedVibe, resolvedMaxComments, preset,
  vibeCommentsClassified = 0, videosChecked = 0,
}) {
  const overridden =
    (includeVibe !== undefined && includeVibe !== preset.includeVibe) ||
    (maxComments !== undefined && maxComments !== preset.maxComments);

  const estimateUsd       = resolvedVibe ? estimateVibeCostUsd(vibeCommentsClassified) : 0;
  const ceilingPerVideoUsd = estimateVibeCostUsd(resolvedMaxComments);
  const ceilingUsd        = resolvedVibe ? Math.round(ceilingPerVideoUsd * videosChecked * 100) / 100 : 0;

  return {
    vibeMode,
    label: overridden ? `Custom (based on ${vibeMode})` : preset.label,
    overridden,
    // Cost figures cover vibe classification only — the lever these presets
    // change. Transcript summaries cost extra but are constant across presets,
    // so they're left out to keep the A/B comparison apples-to-apples.
    cost: {
      currency: 'USD',
      model: MODEL,
      basis: 'Vibe classification only — the lever these presets change. Transcript summaries cost extra and are constant across presets.',
      vibeCommentsClassified,
      estimateUsd,
      ceilingUsd,
    },
    modules: [
      {
        key: 'vibe',
        label: 'Vibe classification',
        value: resolvedVibe ? 'on' : 'off',
        cost: resolvedVibe
          ? `~$${estimateUsd.toFixed(2)} (${vibeCommentsClassified.toLocaleString()} comments)`
          : '$0.00 (off)',
        effect: resolvedVibe
          ? 'Comment sentiment classified into an emoji distribution (Claude API call per ~50 comments).'
          : 'Skipped — integrity scores only, no emoji distribution and no extra Claude API cost.',
      },
      {
        key: 'commentDepth',
        label: 'Comment sample depth',
        value: `${resolvedMaxComments} max`,
        cost: resolvedVibe ? `ceiling ~$${ceilingPerVideoUsd.toFixed(2)}/video` : 'n/a (vibe off)',
        effect: 'Comments sampled per video for integrity + vibe. Deeper = more accurate, higher cost/latency.',
      },
    ],
  };
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
     * @param {string} [params.vibeMode='full'] - A/B preset bundling the cost/quality knobs (see VIBE_PRESETS)
     * @param {boolean} [params.includeVibe] - Override: run vibe classification (defaults to the preset)
     * @param {number} [params.maxComments] - Override: comments to sample per video (defaults to the preset)
     * @param {boolean} [params.includeSeAuthority=true] - Run Stack Exchange authority check
     */
    async generateBrief({
      topic,
      goal,
      playlistName,
      videoCount = 3,
      vibeMode = DEFAULT_VIBE_MODE,
      includeVibe,
      maxComments,
      includeSeAuthority = true,
    }) {
      if (!process.env.ANTHROPIC_API_KEY) {
        throw new Error('ANTHROPIC_API_KEY is required for research_brief.');
      }

      // Resolve the A/B preset, allowing explicit per-field overrides on top.
      const resolvedMode = VIBE_PRESETS[vibeMode] ? vibeMode : DEFAULT_VIBE_MODE;
      const preset = VIBE_PRESETS[resolvedMode];
      const resolvedVibe = includeVibe ?? preset.includeVibe;
      const resolvedMaxComments = maxComments ?? preset.maxComments;

      console.error(`[research-brief] starting brief for topic: "${topic}", goal: "${goal}" — config: ${preset.label} (vibe=${resolvedVibe}, maxComments=${resolvedMaxComments})`);

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
            playlistResult = { id: targetPlaylist.id, name: targetPlaylist.title, ...summary };
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
          const { getChunkedTranscript, classifyTranscriptError } = await import('./transcript-client.js');
          const { getChunkedTranscriptViaWhisper, whisperFallbackAvailable } = await import('./whisper-fallback.js');
          let transcript = null;
          let transcriptErrorClassification = null;
          let transcriptSource = null;

          try {
            const { chunks, totalWords, totalDurationSeconds } = await getChunkedTranscript(videoId, 10 * 60);
            transcript = { chunks, totalWords, totalDurationSeconds };
            transcriptSource = 'youtube_captions';
          } catch (transcriptErr) {
            transcriptErrorClassification = classifyTranscriptError(transcriptErr);
            console.error(`[research-brief] captions failed for ${videoId} (${transcriptErrorClassification}): ${transcriptErr.message}`);

            // Whisper fallback — always attempt it since research_brief
            // prioritizes accuracy over cost. Transcript is non-negotiable
            // for research quality; metadata-only is a last resort only.
            if (whisperFallbackAvailable()) {
              try {
                console.error(`[research-brief] trying Whisper fallback for ${videoId}`);
                const { chunks, totalWords, totalDurationSeconds } = await getChunkedTranscriptViaWhisper(videoId, 10 * 60);
                transcript = { chunks, totalWords, totalDurationSeconds };
                transcriptSource = 'whisper_fallback';
              } catch (whisperErr) {
                console.error(`[research-brief] Whisper fallback also failed for ${videoId}: ${whisperErr.message}`);
              }
            } else {
              console.error(`[research-brief] Whisper fallback unavailable (no OPENAI_API_KEY) for ${videoId}`);
            }
          }

          summaryResult = await summarizeTranscript({
            title: details.title,
            channel: details.channel,
            transcript,
            description: details.description,
            caveat: !transcript ? `Transcript unavailable (${transcriptErrorClassification ?? 'unknown'})` : null,
          });

          // Surface the error classification so callers don't have to re-run
          // youtube_summarize_video manually to diagnose a metadata fallback
          if (transcriptErrorClassification) {
            summaryResult.transcriptErrorClassification = transcriptErrorClassification;
          }
          if (transcriptSource) {
            summaryResult.transcriptSource = transcriptSource;
          }
        } catch (err) {
          console.error(`[research-brief] summarize failed for ${videoId}:`, err.message);
          summaryResult = { summary: `Summary unavailable: ${err.message}`, source: 'error' };
        }

        // Stage 3: Credibility check
        let credibilityResult = null;
        try {
          credibilityResult = await credibilityClient.checkYouTubeVideo({
            videoId,
            maxComments: resolvedMaxComments,
            fetchAllReplies: true,
          });

          // Vibe classification — checkYouTubeVideo only scores integrity, so
          // mirror the orchestrator here: classify comment sentiment and attach
          // a vibe distribution (emoji-keyed counts/percentages) so the brief
          // and the viewer's Research Brief mode can show it per video. Runs
          // before comments are stripped below, and only when requested.
          if (resolvedVibe && credibilityResult.comments?.length) {
            try {
              const classified = await classifyCommentVibes(credibilityResult.comments);
              credibilityResult.vibeDistribution = buildVibeDistribution(classified);
            } catch (vibeErr) {
              console.error(`[research-brief] vibe classification failed for ${videoId}:`, vibeErr.message);
            }
          }

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

      // ── Pull summaries to top level ───────────────────────────────────────
      // Summaries live inside each video object but are the most frequently
      // needed output — pulling them to the top level means any consumer
      // (the credibility viewer, future tooling, the presenting instance)
      // gets them without having to dig into per-video credibility objects.
      // They also remain inside videos[] for full per-video context.
      const summaries = videoResults.map(v => ({
        videoId: v.videoId,
        title: v.title,
        channel: v.channel,
        url: v.url,
        summary: v.summary?.summary ?? null,
        transcriptSource: v.summary?.transcriptSource ?? v.summary?.source ?? null,
        transcriptErrorClassification: v.summary?.transcriptErrorClassification ?? null,
      }));

      // ── Resolve config + cost from the finished run ───────────────────────
      // Count comments actually classified for vibe (0 when vibe is off) so the
      // cost estimate reflects real spend, making A/B preset comparison concrete.
      const vibeCommentsClassified = videoResults.reduce(
        (sum, v) => sum + (v.credibility?.vibeDistribution?.total ?? 0), 0);
      const config = buildBriefConfig({
        vibeMode: resolvedMode, includeVibe, maxComments,
        resolvedVibe, resolvedMaxComments, preset,
        vibeCommentsClassified, videosChecked: videoResults.length,
      });

      // ── Build the brief ───────────────────────────────────────────────────
      return {
        topic,
        goal,
        generatedAt: new Date().toISOString(),
        config,
        playlist: playlistResult,
        headlineIntegrityScore,
        videoCount: videoResults.length,
        summaries,
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
        vibeMode: {
          type: 'string',
          enum: ['full', 'lite', 'off'],
          description: 'A/B preset bundling the cost/quality knobs (default "full"). "full" = vibe on, 1500-comment sample; "lite" = vibe on, 500-comment sample (cheaper/faster); "off" = no vibe classification. The resolved config is echoed back in the brief\'s `config` field.',
        },
        includeVibe: {
          type: 'boolean',
          description: 'Override the preset\'s vibe setting. Run vibe classification on comment sections — set false to skip Claude API sentiment calls (faster, no emoji distribution).',
        },
        maxComments: {
          type: 'number',
          description: 'Override the preset\'s comment sample depth (comments sampled per video for integrity + vibe).',
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
