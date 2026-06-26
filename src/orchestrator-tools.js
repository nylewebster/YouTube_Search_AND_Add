/**
 * orchestrator-tools.js
 *
 * Top-level credibility orchestrator. Takes a URL or topic string,
 * routes to the right platforms, runs both credibility lanes, classifies
 * comment vibe, and returns a unified rtings-style readout.
 *
 * Mirrors the other tool modules: exports createOrchestratorClient(),
 * toolDefinitions (flat array), and handleToolCall(client, name, args).
 *
 * Input auto-detection:
 *   YouTube URL  → integrity check on that video + SE authority search
 *                  from the video's title (cheap metadata fetch)
 *   Topic string → integrity check on top 3 YouTube search results +
 *                  SE authority search on the same topic
 *
 * Output shape:
 *   headlineScore       — average of authority + integrity lanes.
 *                         Marked with asterisk (*) if only one lane
 *                         produced a result (e.g. comments disabled,
 *                         or no SE result found for the topic).
 *   platforms.youtube   — per-video integrity scores + vibe distributions
 *   platforms.stackexchange — authority score for the best-matched question
 *   vibeDistribution    — per-platform and optional combined view
 *   topFlags            — highest botProbability comments across all videos,
 *                         with flagDetails, so consumers don't have to dig
 *
 * Dependencies:
 *   - credibility-tools.js  (checkYouTubeVideo, checkStackExchangeThread)
 *   - vibe-classifier.js    (classifyCommentVibes, buildVibeDistribution)
 *   - youtube-client.js     (getVideoDetails, search — via createYouTubeClient)
 *   - stackexchange-tools.js (searchQuestions — via createStackExchangeClient)
 */

import { classifyCommentVibes, buildVibeDistribution } from './vibe-classifier.js';

// YouTube URL patterns — covers youtu.be short links and all
// youtube.com/watch variants including with extra query params.
const YT_URL_PATTERNS = [
  /(?:youtube\.com\/watch\?(?:.*&)?v=|youtu\.be\/)([A-Za-z0-9_-]{11})/,
];

function extractYouTubeVideoId(input) {
  for (const re of YT_URL_PATTERNS) {
    const m = input.match(re);
    if (m) return m[1];
  }
  return null;
}

function isUrl(input) {
  return /^https?:\/\//i.test(input.trim());
}

/**
 * Pick the best Stack Exchange question from a search result list.
 * Prefers the highest-scored answered question; falls back to the first
 * result if none are answered.
 */
function pickBestSeQuestion(results) {
  if (!results.length) return null;
  const answered = results.filter(q => q.isAnswered);
  if (answered.length) {
    return answered.reduce((best, q) => q.score > best.score ? q : best, answered[0]);
  }
  return results[0];
}

/**
 * Summarize the top N highest bot-probability comments across all scored
 * comment arrays, for inclusion in the orchestrator output without
 * dumping the full per-video comment arrays.
 */
function buildTopFlags(allAnnotatedComments, n = 10) {
  return allAnnotatedComments
    .filter(c => c.botProbability > 0)
    .sort((a, b) => b.botProbability - a.botProbability)
    .slice(0, n)
    .map(c => ({
      author: c.author,
      text: c.text?.slice(0, 100),
      botProbability: c.botProbability,
      flagDetails: c.flagDetails ?? [],
    }));
}

export function createOrchestratorClient({ credibilityClient, youtubeClient, stackExchangeClient }) {
  if (!credibilityClient || !youtubeClient || !stackExchangeClient) {
    throw new Error('createOrchestratorClient requires credibilityClient, youtubeClient, and stackExchangeClient.');
  }

  return {
    async checkCredibility({ input, includeVibe = true }) {
      const trimmed = input.trim();
      const videoIdFromUrl = extractYouTubeVideoId(trimmed);

      // ---- Determine input type and collect raw IDs/queries ----
      let inputType;
      let videoIds = [];       // YouTube video IDs to check
      let seQuery = null;      // Topic string to search Stack Exchange with

      if (videoIdFromUrl) {
        // YouTube URL — single video + derive SE query from title
        inputType = 'youtube_url';
        videoIds = [videoIdFromUrl];

        // Cheap metadata fetch (1 quota unit) to get the title for SE search
        try {
          const details = await youtubeClient.getVideoDetails(videoIdFromUrl);
          // Strip common filler like channel names in brackets, "Official Video", etc.
          seQuery = details.title
            .replace(/\s*[\[\(].*?[\]\)]/g, '')
            .replace(/\s*\|\s*.+$/, '')
            .trim();
        } catch (err) {
          console.error('[orchestrator] Failed to fetch video details for SE query:', err.message);
          seQuery = null; // SE lane will be skipped rather than crashed
        }

      } else if (isUrl(trimmed)) {
        // Non-YouTube URL — unsupported for now
        return {
          input: trimmed,
          inputType: 'unsupported_url',
          error: 'Only YouTube URLs are currently supported. Reddit and other platforms are coming once those integrations are live.',
        };

      } else {
        // Topic string — search YouTube for top 3 videos
        inputType = 'topic';
        seQuery = trimmed;

        try {
          const searchResults = await youtubeClient.search(trimmed, 3, 'relevance');
          videoIds = searchResults.map(r => r.videoId);
        } catch (err) {
          console.error('[orchestrator] YouTube search failed:', err.message);
          videoIds = [];
        }
      }

      if (!videoIds.length && !seQuery) {
        return {
          input: trimmed,
          inputType,
          error: 'Could not find any content to check — YouTube search returned no results and no SE query could be derived.',
        };
      }

      // ---- Run both lanes in parallel ----
      const [youtubeResults, seResult] = await Promise.all([
        // YouTube integrity lane: check all videos
        Promise.all(videoIds.map(async (videoId) => {
          try {
            return await credibilityClient.checkYouTubeVideo({ videoId });
          } catch (err) {
            console.error(`[orchestrator] YouTube integrity check failed for ${videoId}:`, err.message);
            return { videoId, error: err.message };
          }
        })),

        // Stack Exchange authority lane
        seQuery ? (async () => {
          try {
            const results = await stackExchangeClient.searchQuestions({
              query: seQuery,
              site: 'stackoverflow',
              limit: 10,
            });
            const best = pickBestSeQuestion(results);
            if (!best) return null;

            return await credibilityClient.checkStackExchangeThread({
              questionId: best.id,
              site: 'stackoverflow',
            });
          } catch (err) {
            console.error('[orchestrator] SE authority check failed:', err.message);
            return null;
          }
        })() : Promise.resolve(null),
      ]);

      // ---- Vibe classification ----
      // Run after integrity check so botProbability is already on each comment
      const youtubeVibes = [];
      if (includeVibe) {
        for (const ytResult of youtubeResults) {
          if (ytResult.error || ytResult.commentsDisabled || !ytResult.comments?.length) {
            youtubeVibes.push(null);
            continue;
          }
          try {
            const classified = await classifyCommentVibes(ytResult.comments);
            youtubeVibes.push(buildVibeDistribution(classified));
          } catch (err) {
            console.error('[orchestrator] Vibe classification failed:', err.message);
            youtubeVibes.push(null);
          }
        }
      }

      // ---- Assemble output ----

      // Authority score: average of SE answers' per-answer authority scores
      const authorityScore = seResult?.overallAuthorityScore ?? null;

      // Integrity score: average across all videos that produced a score
      const validYtScores = youtubeResults
        .filter(r => !r.error && !r.commentsDisabled && r.integrityScore != null)
        .map(r => r.integrityScore);
      const integrityScore = validYtScores.length
        ? Math.round(validYtScores.reduce((s, v) => s + v, 0) / validYtScores.length * 10) / 10
        : null;

      // Headline score — average of available lanes, asterisked if partial
      let headlineScore = null;
      let headlineNote = null;
      const laneScores = [authorityScore, integrityScore].filter(s => s != null);
      if (laneScores.length === 2) {
        headlineScore = Math.round((authorityScore + integrityScore) / 2);
      } else if (laneScores.length === 1) {
        headlineScore = Math.round(laneScores[0]);
        headlineNote = authorityScore == null
          ? '* Single-lane score (Stack Exchange authority lane unavailable — no relevant question found).'
          : '* Single-lane score (YouTube integrity lane unavailable — comments disabled or no results).';
      }

      // topFlags — highest botProbability comments across all videos
      const allAnnotated = youtubeResults.flatMap(r => r.comments ?? []);
      const topFlags = buildTopFlags(allAnnotated);

      // Per-platform YouTube output — strip the full comments array
      // to keep the orchestrator output readable
      const youtubeOutput = youtubeResults.map((r, i) => {
        const { comments: _dropped, ...rest } = r;
        return {
          ...rest,
          ...(youtubeVibes[i] ? { vibeDistribution: youtubeVibes[i] } : {}),
        };
      });

      // Combined vibe distribution across all videos (optional view)
      let combinedVibeDistribution = null;
      const validVibes = youtubeVibes.filter(Boolean);
      if (validVibes.length > 1) {
        const combined = { counts: {}, total: 0, suspiciousCount: 0 };
        for (const v of validVibes) {
          for (const [bucket, count] of Object.entries(v.counts)) {
            combined.counts[bucket] = (combined.counts[bucket] ?? 0) + count;
          }
          combined.total += v.total;
          combined.suspiciousCount += v.suspiciousCount;
        }
        combined.percentages = Object.fromEntries(
          Object.entries(combined.counts).map(([b, c]) => [b, Math.round((c / combined.total) * 100)])
        );
        combinedVibeDistribution = combined;
      }

      return {
        input: trimmed,
        inputType,
        topic: seQuery,
        headlineScore,
        headlineNote,
        platforms: {
          youtube: {
            videos: youtubeOutput,
            ...(validYtScores.length > 1 ? { combinedIntegrityScore: integrityScore } : {}),
          },
          stackexchange: seResult ? {
            questionId: seResult.questionId,
            site: seResult.site,
            sampleSize: seResult.sampleSize,
            overallAuthorityScore: seResult.overallAuthorityScore,
            answers: seResult.answers,
          } : null,
        },
        vibeDistribution: {
          perVideo: youtubeVibes.map((v, i) => v ? { videoId: videoIds[i], ...v } : null).filter(Boolean),
          combined: combinedVibeDistribution,
          note: combinedVibeDistribution ? null : validVibes.length === 1
            ? 'Only one video with comments — combined view not applicable.'
            : 'Vibe classification unavailable.',
        },
        topFlags,
        dataSufficiency: laneScores.length === 2 ? 'full' : laneScores.length === 1 ? 'partial' : 'none',
      };
    },
  };
}

export const toolDefinitions = [
  {
    name: 'credibility_check',
    description:
      'Top-level credibility check for a YouTube URL or topic string. Automatically routes to the right platforms: a YouTube URL checks that specific video\'s comment integrity + searches Stack Exchange for related authority signals; a topic string searches YouTube\'s top 3 videos + the best matching Stack Exchange question. Returns a unified readout: headline score (asterisked if only one lane available), per-platform integrity/authority scores, per-video vibe distributions (😊/😐/😡/😂/🙃 + 🤖 suspicious count), and the top flagged comments with reasons. Heuristic-only — this is a triage signal, not a verdict.',
    inputSchema: {
      type: 'object',
      properties: {
        input: {
          type: 'string',
          description: 'A YouTube URL (e.g. https://youtu.be/abc123) or a topic/search string (e.g. "RTX 5070 Ti review")',
        },
        includeVibe: {
          type: 'boolean',
          description: 'Run sentiment classification on comments to produce vibe distributions (default true). Set false to skip the Claude API classification step and return scores only — faster and cheaper.',
        },
      },
      required: ['input'],
    },
  },
];

export async function handleToolCall(client, name, args) {
  switch (name) {
    case 'credibility_check': {
      const result = await client.checkCredibility(args);
      return [{ type: 'text', text: JSON.stringify(result, null, 2) }];
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
