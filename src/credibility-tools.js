/**
 * credibility-tools.js
 *
 * Mirrors youtube-tools.js / stackexchange-tools.js: exports
 * createCredibilityClient(), toolDefinitions (flat array), and
 * handleToolCall(client, name, args).
 *
 * This module is a composer, not a fetcher — it has no API calls of its
 * own. It takes already-built service clients (currently: the Stack
 * Exchange client; YouTube/Reddit join once those signals are ready) and
 * derives a credibility readout from their existing methods.
 *
 * Scoring model — two lanes:
 *   - authorityScore:  direct platform reputation signals (0-100)
 *   - integrityScore:  noisy-OR combination of bot-likelihood flags (0-100)
 * blended toward neutral (50) when the sample size is thin. Both lanes
 * are always returned alongside the headline number — never collapse to
 * just the average, the point is to show the work (rtings-style).
 */

// ---------------------------------------------------------------------
// Pure scoring primitives — no network, no I/O. Exported separately so
// they're unit-testable without spinning up any client, and so future
// platform modules (YouTube comments, Reddit threads) can feed them
// flag arrays without depending on this module's client internals.
// ---------------------------------------------------------------------

/**
 * Combine independent suspicion probabilities so weak signals barely move
 * the result alone, but converging signals compound quickly:
 *   P(bot) = 1 - ∏(1 - p_i)
 * @param {number[]} flagProbabilities - each in [0, 1]
 * @returns {number} combined probability in [0, 1]
 */
export function noisyOrCombine(flagProbabilities = []) {
  if (flagProbabilities.length === 0) return 0;
  const survival = flagProbabilities.reduce((acc, p) => {
    const clamped = Math.min(Math.max(p, 0), 1);
    return acc * (1 - clamped);
  }, 1);
  return 1 - survival;
}

/**
 * Older accounts dampen suspicion rather than adding their own independent
 * signal — matches how real platform bot-detection treats age (a modifier,
 * not a standalone flag; see BotBlock/Reddit CQS research). Returns a
 * multiplier in [floor, 1.0].
 * @param {number} accountAgeDays
 * @param {number} floor - minimum multiplier for very new accounts (default 0.3)
 * @param {number} maturityDays - age at which the multiplier reaches 1.0 (default 365)
 */
export function ageModifier(accountAgeDays, floor = 0.3, maturityDays = 365) {
  if (accountAgeDays == null || Number.isNaN(accountAgeDays)) return 1; // unknown age: no dampening, no penalty
  const ratio = accountAgeDays / maturityDays;
  return Math.min(Math.max(ratio, floor), 1);
}

/**
 * Pulls a score toward neutral (50) when the underlying sample is thin, so
 * a handful of comments can't swing the result to an extreme.
 * @param {number} score - 0-100
 * @param {number} sampleSize
 * @param {number} fullConfidenceAt - sample size at which confidence reaches 1.0 (default 30)
 */
export function sufficiencyBlend(score, sampleSize, fullConfidenceAt = 30) {
  const confidence = Math.min(Math.max(sampleSize / fullConfidenceAt, 0), 1);
  return score * confidence + 50 * (1 - confidence);
}

/**
 * Top-level integrity score for a batch of items (comments, posts, etc.),
 * each pre-scored as a set of flag probabilities plus an optional account
 * age in days.
 * @param {Array<{ flags: number[], accountAgeDays?: number }>} items
 * @returns {{ integrityScore: number, sampleSize: number, perItemBotProbability: number[] }}
 */
export function computeIntegrityScore(items = []) {
  const perItemBotProbability = items.map(({ flags = [], accountAgeDays } = {}) => {
    const modifier = ageModifier(accountAgeDays);
    const dampened = flags.map((p) => p * modifier);
    return noisyOrCombine(dampened);
  });

  const sampleSize = perItemBotProbability.length;
  if (sampleSize === 0) {
    return { integrityScore: 50, sampleSize, perItemBotProbability }; // no data: neutral, not a guess
  }

  const avgBotProbability =
    perItemBotProbability.reduce((sum, p) => sum + p, 0) / sampleSize;
  const rawIntegrityScore = 100 * (1 - avgBotProbability);

  return {
    integrityScore: sufficiencyBlend(rawIntegrityScore, sampleSize),
    sampleSize,
    perItemBotProbability,
  };
}

/** Final headline number: simple average of the two lanes. */
export function computeHeadlineScore(authorityScore, integrityScore) {
  return Math.round((authorityScore + integrityScore) / 2);
}

/**
 * How much benefit of the doubt a zero/low-vote answer gets, based on how
 * long it's been live. "0 votes" alone is ambiguous — could be a bad
 * answer, could just be new. A brand-new answer hasn't had time to be
 * judged; an old, still-unvoted one has, and that absence becomes a real
 * signal rather than noise.
 * @param {number|null} ageHours - hours since the answer was posted, or null if unknown
 */
export function freshnessFloor(ageHours) {
  if (ageHours == null) return 15; // unknown age: small neutral floor, same spirit as unknown reputation
  if (ageHours < 24) return 30;    // under a day old: meaningful benefit of the doubt
  if (ageHours < 24 * 7) return 15; // under a week: partial benefit of the doubt
  return 0;                         // a week+ with zero votes is a real (negative) signal now
}

/**
 * This answer's own community reception — votes plus accepted status.
 * The primary signal for authority scoring; reputation only modifies it.
 * Log-scaled so a handful of votes can't saturate the scale, but a
 * realistic "good answer" vote count (tens to hundreds) reaches most of
 * the range. Zero-vote answers fall back to the freshness floor instead
 * of a flat penalty.
 * @param {number} score - net vote count
 * @param {boolean} isAccepted
 * @param {number|null} ageHours
 */
export function communityScore(score, isAccepted, ageHours) {
  const voteScore = Math.min(85, 30 * Math.log10(Math.max(score, 0) + 1));
  const floor = score === 0 ? freshnessFloor(ageHours) : 0;
  return Math.max(voteScore, floor) + (isAccepted ? 15 : 0);
}

/**
 * Reputation as a modifier, not an independent point source — a high-rep
 * author nudges an already-good answer up slightly, but can't single-
 * handedly carry an answer the community hasn't endorsed. Range is
 * deliberately narrow (0.85–1.15) so it can never override communityScore.
 * @param {number|null} reputation
 */
export function reputationModifier(reputation) {
  if (reputation == null) return 1; // unknown reputation: no nudge either way
  const logRep = Math.log10(Math.max(reputation, 1) + 1);
  return Math.min(1.15, Math.max(0.85, 0.85 + (logRep / 6) * 0.3));
}

/**
 * Combines the above into a single per-answer authority score (0-100).
 * @param {{ score: number, isAccepted: boolean, reputation: number|null, ageHours: number|null }} params
 */
export function computeStackExchangeAuthorityScore({ score, isAccepted, reputation, ageHours }) {
  const community = communityScore(score, isAccepted, ageHours);
  const modifier = reputationModifier(reputation);
  return Math.min(100, community * modifier);
}

// ---------------------------------------------------------------------
// YouTube comment integrity-lane heuristics — pure, no I/O. Each flag is
// deliberately weak in isolation (see noisyOrCombine above): the point is
// that convergence of several weak signals is what should move a score,
// not any single one. None of these use account age — that's not
// available without a channels.list call per unique commenter, which is
// a deliberate cost decision deferred for now. ageModifier already
// handles a missing age gracefully (no dampening, no penalty), so this
// slots into computeIntegrityScore with zero changes there.
// ---------------------------------------------------------------------

function normalizeCommentText(text = '') {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const GENERIC_PHRASES = [
  'great video', 'nice video', 'awesome video', 'good video', 'love this',
  'love this video', 'first', 'amazing', 'so good', 'this is awesome',
  'great content', 'keep it up', 'subscribed', 'underrated channel',
];

function isGenericPhrase(normalizedText) {
  // Generic spam-style praise is short. A long comment that happens to
  // contain "great video" mid-sentence is a different thing entirely and
  // shouldn't trip this.
  if (!normalizedText || normalizedText.split(' ').length > 6) return false;
  return GENERIC_PHRASES.some((p) => normalizedText === p || normalizedText.includes(p));
}

const SPAM_PATTERNS = [
  /https?:\/\//i,
  /\bwww\./i,
  /check (out )?my (channel|page|bio)/i,
  /\bdm me\b/i,
  /\bfollow (me|back)\b/i,
  /\bfree (followers|subscribers|money)\b/i,
];

function hasSpamPattern(text = '') {
  return SPAM_PATTERNS.some((re) => re.test(text));
}

/**
 * Groups comments by normalized text, tracking how many DISTINCT authors
 * posted each one — the actual bot-network signature is the same text
 * from different accounts, not just a popular phrase repeated by one
 * person across replies.
 */
export function buildTextClusters(comments) {
  const clusters = new Map();
  for (const c of comments) {
    const key = normalizeCommentText(c.text);
    if (!key) continue;
    const distinctAuthors = clusters.get(key) ?? new Set();
    distinctAuthors.add(c.authorChannelId ?? c.author);
    clusters.set(key, distinctAuthors);
  }
  return clusters;
}

/**
 * Duplicate-text flag: near-identical text from multiple distinct
 * authors. A cluster of 1 (just this comment) is normal — flag stays 0.
 * Growing distinct-author count compounds, capped well under 1.0 since
 * this is one signal among several, not a standalone verdict.
 */
export function duplicateTextFlag(comment, clusters) {
  const key = normalizeCommentText(comment.text);
  if (!key) return 0;
  const distinctAuthors = clusters.get(key)?.size ?? 1;
  if (distinctAuthors <= 1) return 0;
  return Math.min(0.75, 0.15 * Math.log2(distinctAuthors + 1) + 0.1);
}

/** Weak on its own — short, generic, context-free praise is common from real people too. */
export function genericPhraseFlag(comment) {
  return isGenericPhrase(normalizeCommentText(comment.text)) ? 0.12 : 0;
}

/** Moderate signal — URLs and self-promo patterns are a clearer tell than generic praise. */
export function spamPatternFlag(comment) {
  return hasSpamPattern(comment.text) ? 0.4 : 0;
}

/** Buckets comments by a fixed time window (default 60s) to find posting-rate spikes. */
export function buildTimeBuckets(comments, bucketSeconds = 60) {
  const buckets = new Map();
  for (const c of comments) {
    if (!c.publishedAt) continue;
    const t = Math.floor(new Date(c.publishedAt).getTime() / 1000 / bucketSeconds);
    buckets.set(t, (buckets.get(t) ?? 0) + 1);
  }
  return buckets;
}

function median(numbers) {
  if (numbers.length === 0) return 0;
  const sorted = [...numbers].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Burst-timing flag: this comment landed in a time bucket far denser than
 * the video's own typical pacing. Relative to the sample's median bucket
 * density, not an absolute threshold — a viral video's normal pace is a
 * slow trickle's bot-network density, so "normal" has to be per-video.
 */
export function burstTimingFlag(comment, buckets, medianBucketCount, bucketSeconds = 60) {
  if (!comment.publishedAt || medianBucketCount === 0) return 0;
  const t = Math.floor(new Date(comment.publishedAt).getTime() / 1000 / bucketSeconds);
  const count = buckets.get(t) ?? 1;
  const ratio = count / Math.max(medianBucketCount, 1);
  if (ratio < 3) return 0; // unremarkable density, don't flag at all
  return Math.min(0.5, 0.15 * Math.log2(ratio));
}

/**
 * Builds the full flags array for one comment, given the whole sample for
 * context (cluster/burst comparisons need the full set, not just one
 * comment in isolation). Precompute clusters/buckets once per video and
 * pass them in — see computeYouTubeIntegrityScore below — rather than
 * recomputing per comment.
 */
export function computeYouTubeCommentFlags(comment, { clusters, buckets, medianBucketCount }) {
  return [
    duplicateTextFlag(comment, clusters),
    genericPhraseFlag(comment),
    spamPatternFlag(comment),
    burstTimingFlag(comment, buckets, medianBucketCount),
  ].filter((p) => p > 0);
}

/**
 * Full integrity-lane score for a video's comment sample. Wraps the
 * existing computeIntegrityScore (defined above) — same sufficiency
 * dampening for thin samples, same noisy-OR convergence model, just fed
 * YouTube-specific flags instead of generic ones.
 * @param {Array<{ text: string, authorChannelId: string|null, author: string, publishedAt: string }>} comments
 */
export function computeYouTubeIntegrityScore(comments) {
  const clusters = buildTextClusters(comments);
  const buckets = buildTimeBuckets(comments);
  const medianBucketCount = median([...buckets.values()]);

  const items = comments.map((c) => ({
    flags: computeYouTubeCommentFlags(c, { clusters, buckets, medianBucketCount }),
    // accountAgeDays intentionally omitted — see file header note above.
  }));

  return computeIntegrityScore(items);
}

// ---------------------------------------------------------------------
// Client — composes existing service clients. No fetch() of its own.
// ---------------------------------------------------------------------

export function createCredibilityClient({ stackExchangeClient, youtubeClient } = {}) {
  if (!stackExchangeClient && !youtubeClient) {
    throw new Error('createCredibilityClient requires at least one of stackExchangeClient or youtubeClient.');
  }

  return {
    /**
     * Authority-lane credibility for a Stack Exchange answer thread.
     *
     * Scoring philosophy (revised after testing against real threads):
     * an answer's OWN community reception (votes, accepted status) is the
     * primary signal, and the answerer's platform-wide reputation acts as
     * a modifier — a nudge, not an independent source of points. The
     * first version did this backwards (reputation could single-handedly
     * max out the score) and a real test case exposed it: a 0-vote answer
     * with clearly wrong content scored 88/100 purely because its author
     * had 209k reputation elsewhere on the site.
     *
     * Zero/low-vote answers get a freshness floor instead of a flat
     * penalty, since "0 votes" is ambiguous — it could mean "bad answer"
     * or "answer posted 17 minutes ago and nobody's seen it yet." Age
     * resolves that ambiguity the same way it already does in the
     * integrity-lane noisy-OR model: a modifier on an otherwise weak
     * signal, not a verdict on its own.
     *
     * NOTE: requires stackexchange-tools.js's getAnswers() to expose
     * ownerReputation and creationDate, which the SE API already returns
     * but the original mapped shape dropped. See the accompanying patch.
     */
    async checkStackExchangeThread({ questionId, site = 'stackoverflow', limit = 10 }) {
      if (!stackExchangeClient) {
        throw new Error('checkStackExchangeThread requires a stackExchangeClient.');
      }
      const answers = await stackExchangeClient.getAnswers({ questionId, site, limit });
      const nowEpochSeconds = Date.now() / 1000;

      const scored = answers.map((a) => {
        const reputation = a.ownerReputation ?? null;
        const ageHours = a.creationDate != null
          ? (nowEpochSeconds - a.creationDate) / 3600
          : null;

        const authorityScore = computeStackExchangeAuthorityScore({
          score: a.score,
          isAccepted: a.isAccepted,
          reputation,
          ageHours,
        });

        return { ...a, ageHours: ageHours != null ? Math.round(ageHours * 10) / 10 : null, authorityScore };
      });

      const overallAuthority = scored.length
        ? Math.round(scored.reduce((sum, a) => sum + a.authorityScore, 0) / scored.length)
        : 50;

      return {
        platform: 'stackexchange',
        questionId,
        site,
        sampleSize: scored.length,
        overallAuthorityScore: overallAuthority,
        answers: scored,
        note: scored.length < 3
          ? 'Thin sample (fewer than 3 answers) — treat this score as low-confidence.'
          : undefined,
      };
    },

    /**
     * Integrity-lane credibility for a YouTube video's comment section.
     * Composes YouTubeClient.getCommentsForCredibilityCheck() (full
     * pagination + full reply chains) with computeYouTubeIntegrityScore
     * (the noisy-OR heuristics defined above: duplicate-text clustering,
     * generic-phrase matching, spam patterns, posting-burst timing).
     *
     * No account-age signal here — that would need a channels.list call
     * per unique commenter, a cost decision deliberately deferred. This
     * is a heuristic triage signal, not a verdict: validated against both
     * synthetic data (a known-correct bot cluster, confirmed separated
     * cleanly from organic comments) and real video comments (zero false
     * positives on a genuinely messy, sarcastic, on-topic comment
     * section).
     */
    async checkYouTubeVideo({ videoId, maxComments = 500, fetchAllReplies = true }) {
      if (!youtubeClient) {
        throw new Error('checkYouTubeVideo requires a youtubeClient.');
      }
      const { commentsDisabled, comments } = await youtubeClient.getCommentsForCredibilityCheck(videoId, {
        maxComments,
        fetchAllReplies,
      });

      if (commentsDisabled) {
        return {
          platform: 'youtube',
          videoId,
          commentsDisabled: true,
          integrityScore: null,
          sampleSize: 0,
          note: 'Comments are disabled on this video — integrity lane unavailable, not a low score.',
        };
      }

      const { integrityScore, sampleSize, perItemBotProbability } = computeYouTubeIntegrityScore(comments);

      const annotated = comments.map((c, i) => ({
        ...c,
        botProbability: Math.round(perItemBotProbability[i] * 1000) / 1000,
      }));

      return {
        platform: 'youtube',
        videoId,
        commentsDisabled: false,
        integrityScore: Math.round(integrityScore * 10) / 10,
        sampleSize,
        comments: annotated,
        note: sampleSize < 30
          ? 'Thin sample (fewer than 30 comments) — score is dampened toward neutral (50) accordingly.'
          : undefined,
      };
    },
  };
}

export const toolDefinitions = [
  {
    name: 'credibility_check_stackexchange',
    description:
      "Authority-lane credibility check for a Stack Exchange answer thread: combines answerer reputation, accepted-answer status, and vote score into a 0-100 score per answer plus an overall average. This reflects the platform's own trust data, not a heuristic guess — treat low sample-size results as low-confidence.",
    inputSchema: {
      type: 'object',
      properties: {
        questionId: { type: 'number', description: 'The question_id from a stackexchange_search result' },
        site: { type: 'string', description: "SE site slug matching the question's site (default 'stackoverflow')" },
        limit: { type: 'number', description: 'Max answers to evaluate (default 10)' },
      },
      required: ['questionId'],
    },
  },
  {
    name: 'credibility_check_youtube',
    description:
      "Integrity-lane credibility check for a YouTube video's comment section: fetches a large, paginated sample of comments (including full reply chains beyond YouTube's free inline 5) and scores them for bot-likelihood using converging heuristics — duplicate-text clustering across distinct accounts, generic low-effort phrase matching, spam/self-promo patterns, and posting-burst timing. Returns a 0-100 integrity score (dampened toward neutral on thin samples) plus per-comment bot-probability for transparency. Heuristic-only — no account-age or device signal — this is a triage flag for further review, not a verdict.",
    inputSchema: {
      type: 'object',
      properties: {
        videoId: { type: 'string', description: 'YouTube video ID to check' },
        maxComments: { type: 'number', description: 'Max comments to sample, including replies (default 500)' },
        fetchAllReplies: {
          type: 'boolean',
          description: 'Fetch full reply chains beyond the 5 YouTube includes inline (default true) — costs 1 extra quota unit per thread that has more than 5 replies',
        },
      },
      required: ['videoId'],
    },
  },
];

export async function handleToolCall(client, name, args) {
  switch (name) {
    case 'credibility_check_stackexchange': {
      const result = await client.checkStackExchangeThread(args);
      return [{ type: 'text', text: JSON.stringify(result, null, 2) }];
    }
    case 'credibility_check_youtube': {
      const result = await client.checkYouTubeVideo(args);
      return [{ type: 'text', text: JSON.stringify(result, null, 2) }];
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
