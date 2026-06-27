/**
 * stackexchange-smart-search-tools.js
 *
 * Mirrors the pattern of query-refiner.js (used by youtube_smart_search_and_add)
 * but applied to Stack Exchange's structured tag system rather than YouTube's
 * free-text search. Exports createStackExchangeSmartSearchClient(),
 * toolDefinitions, and handleToolCall.
 *
 * The three-stage pipeline:
 *
 *   1. SITE SELECTION — Claude picks the right SE site from the cached site
 *      list given the user's plain-language goal. Stack Overflow isn't always
 *      right: a GT7 question belongs on Arqade, a cooking question on Cooking,
 *      a fact-check on Skeptics.
 *
 *   2. TAG DISCOVERY — Claude proposes candidate tag terms, we confirm which
 *      ones actually exist on the chosen site via /tags?inname=, and build a
 *      confirmed tag set. Uncapped by design — accuracy over quota efficiency
 *      given the 10k/day budget.
 *
 *   3. JUDGMENT LOOP — same converging-retry model as youtube_smart_search_and_add:
 *      search with confirmed tags, judge results against the original goal,
 *      rewrite query/tags if off-target, retry up to maxAttempts times. Returns
 *      best results plus a full attempt log so the reasoning is auditable.
 *
 * Natural language → tag translation is the core value here. SE's search
 * responds to [python] async return value very differently than
 * "why doesn't my python async function return anything" — the former uses
 * the site's actual tag taxonomy, the latter is treated as undifferentiated
 * free text. This module handles that translation invisibly.
 */

const ANTHROPIC_API_BASE = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-6';

async function claudeCall(systemPrompt, userContent, maxTokens = 500) {
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

function parseJson(text) {
  try {
    return JSON.parse(text.replace(/```json|```/g, '').trim());
  } catch {
    return null;
  }
}

/**
 * Stage 1: Pick the right SE site for a given goal.
 * Returns { site, siteName, reasoning } or falls back to 'stackoverflow'.
 */
async function selectSite(goal, sites) {
  const siteList = sites
    .map(s => `${s.site} — ${s.name} (${s.audience})`)
    .join('\n');

  const raw = await claudeCall(
    `You are a Stack Exchange site selector. Given a user's research goal, pick the single most relevant Stack Exchange site from the list provided.

Respond ONLY with valid JSON in this exact shape:
{"site":"site-slug","siteName":"Human Name","reasoning":"one sentence"}

Rules:
- Use "stackoverflow" for programming, code, software tools
- Use "arqade" for video games (including Gran Turismo, Guilty Gear, etc.)
- Use "superuser" for PC hardware, Windows, general computing
- Use "skeptics" for fact-checking claims
- Use "cooking", "parenting", "music", etc. for their obvious domains
- When genuinely unclear, default to "stackoverflow"`,
    `Goal: ${goal}\n\nAvailable sites:\n${siteList}`
  );

  const parsed = parseJson(raw);
  if (!parsed?.site) {
    console.error('[se-smart-search] selectSite parse failed, defaulting to stackoverflow');
    return { site: 'stackoverflow', siteName: 'Stack Overflow', reasoning: 'fallback' };
  }
  return parsed;
}

/**
 * Stage 2: Translate plain language into confirmed SE tags.
 * Claude proposes candidate terms → we verify each exists on the site → return confirmed tags.
 *
 * @param {string} goal - plain language description of what to find
 * @param {string} site - SE site slug
 * @param {object} seClient - the Stack Exchange client (for searchTags)
 * @returns {{ confirmedTags: string[], tagDetails: object[], candidatesTriedCount: number }}
 */
async function discoverTags(goal, site, seClient) {
  // Ask Claude to propose candidate tag terms — raw concepts, not SE tag syntax yet
  const raw = await claudeCall(
    `You are a Stack Exchange tag expert. Given a research goal and a site, propose the most relevant tag terms to search for on that site.

Respond ONLY with valid JSON: {"candidates":["term1","term2","term3"]}

Rules:
- Propose 2-6 candidate terms (single words or short hyphenated phrases)
- Think about how SE tags are structured: they're lowercase, often hyphenated (e.g. "gran-turismo", "async-await", "data-structures")
- Don't include version numbers unless the question is version-specific
- Order by likelihood of being a real tag on this site`,
    `Goal: ${goal}\nSite: ${site}`
  );

  const parsed = parseJson(raw);
  const candidates = parsed?.candidates ?? [];

  if (!candidates.length) {
    console.error('[se-smart-search] discoverTags: no candidates returned');
    return { confirmedTags: [], tagDetails: [], candidatesTriedCount: 0 };
  }

  // Verify each candidate against the real tag index on this site
  const confirmed = [];
  const tagDetails = [];

  for (const term of candidates) {
    try {
      const tags = await seClient.searchTags({ inname: term, site, limit: 3 });
      if (tags.length > 0) {
        // Take the most popular matching tag — if we searched "async" and got
        // "async-await" (50k questions) and "async" (8k questions), prefer the
        // most established one that still contains our term
        const best = tags[0];
        confirmed.push(best.name);
        tagDetails.push({ candidate: term, resolvedTag: best.name, questionCount: best.count });
        console.error(`[se-smart-search] tag confirmed: "${term}" → [${best.name}] (${best.count} questions)`);
      } else {
        console.error(`[se-smart-search] tag not found on ${site}: "${term}"`);
        tagDetails.push({ candidate: term, resolvedTag: null, questionCount: 0 });
      }
    } catch (err) {
      console.error(`[se-smart-search] tag search failed for "${term}":`, err.message);
      tagDetails.push({ candidate: term, resolvedTag: null, questionCount: 0, error: err.message });
    }
  }

  // Deduplicate — two candidates might resolve to the same tag
  const uniqueConfirmed = [...new Set(confirmed)];
  return { confirmedTags: uniqueConfirmed, tagDetails, candidatesTriedCount: candidates.length };
}

/**
 * Stage 3: Search with confirmed tags, judge relevance, retry if needed.
 * Same converging-loop model as youtube_smart_search_and_add.
 *
 * @returns {{ results, attempts, finalQuery, finalTags }}
 */
async function judgmentLoop({ goal, site, initialTags, seClient, maxAttempts = 3 }) {
  const attempts = [];
  let currentQuery = '';  // free-text component, starts empty — tags do the heavy lifting
  let currentTags = initialTags.slice(0, 5).join(';'); // SE accepts semicolon-separated tags
  let bestResults = [];

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    console.error(`[se-smart-search] attempt ${attempt}/${maxAttempts} — tags: [${currentTags}] query: "${currentQuery}"`);

    let results = [];
    let searchError = null;

    try {
      results = await seClient.searchQuestions({
        query: currentQuery || undefined,
        tags: currentTags || undefined,
        site,
        sort: 'relevance',
        limit: 10,
      });
    } catch (err) {
      searchError = err.message;
      console.error('[se-smart-search] search failed:', err.message);
    }

    // Judge the results against the goal
    const judgmentRaw = await claudeCall(
      `You are a Stack Exchange search quality judge. Given a user's research goal and search results, decide if the results are relevant enough to return.

Respond ONLY with valid JSON:
{"relevant":true|false,"score":0-10,"reasoning":"one sentence","suggestedQuery":"optional free-text refinement","suggestedTags":"optional semicolon-separated tag refinement"}

Rules:
- relevant=true if most results actually address the goal
- score reflects overall relevance (8+ = great, 5-7 = acceptable, below 5 = retry)
- If not relevant, suggest a better query and/or different tags
- suggestedTags should use SE tag syntax (lowercase, hyphenated)
- If results are empty or errored, score=0 and suggest a different approach`,
      `Goal: ${goal}
Site: ${site}
Tags used: [${currentTags}]
Query used: "${currentQuery}"
${searchError ? `Search error: ${searchError}` : ''}
Results (${results.length}):
${results.slice(0, 5).map((r, i) => `${i + 1}. ${r.title} [${r.tags?.join(', ')}] score:${r.score} answered:${r.isAnswered}`).join('\n')}`
    );

    const judgment = parseJson(judgmentRaw) ?? { relevant: false, score: 0, reasoning: 'parse failed' };

    attempts.push({
      attempt,
      tags: currentTags,
      query: currentQuery,
      resultCount: results.length,
      score: judgment.score,
      reasoning: judgment.reasoning,
      relevant: judgment.relevant,
    });

    if (results.length > bestResults.length || (judgment.score > (attempts[attempts.length - 2]?.score ?? 0))) {
      bestResults = results;
    }

    if (judgment.relevant || attempt === maxAttempts) break;

    // Rewrite for next attempt
    if (judgment.suggestedTags) currentTags = judgment.suggestedTags;
    if (judgment.suggestedQuery) currentQuery = judgment.suggestedQuery;
  }

  return {
    results: bestResults,
    attempts,
    finalQuery: currentQuery,
    finalTags: currentTags,
  };
}

// ─── Public client factory ────────────────────────────────────────────────────

export function createStackExchangeSmartSearchClient({ stackExchangeClient }) {
  if (!stackExchangeClient) {
    throw new Error('createStackExchangeSmartSearchClient requires a stackExchangeClient.');
  }

  return {
    async smartSearch({ goal, maxAttempts = 3 }) {
      if (!process.env.ANTHROPIC_API_KEY) {
        throw new Error('ANTHROPIC_API_KEY is required for smart search — falling back is not available here.');
      }

      // Stage 1: site selection
      const sites = await stackExchangeClient.listSites({ limit: 200 });
      const { site, siteName, reasoning: siteReasoning } = await selectSite(goal, sites);
      console.error(`[se-smart-search] selected site: ${site} (${siteName}) — ${siteReasoning}`);

      // Stage 2: tag discovery
      const { confirmedTags, tagDetails, candidatesTriedCount } = await discoverTags(goal, site, stackExchangeClient);
      console.error(`[se-smart-search] confirmed ${confirmedTags.length}/${candidatesTriedCount} candidate tags: [${confirmedTags.join(', ')}]`);

      // Stage 3: judgment loop
      const { results, attempts, finalQuery, finalTags } = await judgmentLoop({
        goal,
        site,
        initialTags: confirmedTags,
        seClient: stackExchangeClient,
        maxAttempts,
      });

      return {
        goal,
        site,
        siteName,
        siteReasoning,
        tagDiscovery: { candidatesTriedCount, tagDetails, confirmedTags },
        finalTags,
        finalQuery,
        searchAttempts: attempts,
        results,
        note: results.length === 0
          ? 'No results found after all attempts — the topic may not have Stack Exchange coverage.'
          : attempts.at(-1)?.relevant === false
            ? 'Results may be imperfect — max attempts reached before a fully relevant result was found.'
            : undefined,
      };
    },
  };
}

// ─── Tool definitions ─────────────────────────────────────────────────────────

export const toolDefinitions = [
  {
    name: 'stackexchange_smart_search',
    description:
      'Search Stack Exchange using plain natural language — no need to know which site to use or how SE tags work. Automatically selects the right site (Stack Overflow, Arqade for games, Skeptics for fact-checking, etc.), translates your description into Stack Exchange\'s preferred tag system, confirms tags actually exist on that site, then runs a self-correcting search loop that retries with better queries if the first attempt misses. Returns the best matching questions plus a full log of every attempt and its reasoning.',
    inputSchema: {
      type: 'object',
      properties: {
        goal: {
          type: 'string',
          description: 'Plain-language description of what you\'re trying to find, e.g. "why does my Python async function not return a value" or "best lap technique for the corkscrew at Laguna Seca in Gran Turismo"',
        },
        maxAttempts: {
          type: 'number',
          description: 'Max search/refinement attempts before returning best result found (default 3)',
        },
      },
      required: ['goal'],
    },
  },
];

// ─── Dispatcher ───────────────────────────────────────────────────────────────

export async function handleToolCall(client, name, args) {
  switch (name) {
    case 'stackexchange_smart_search': {
      const result = await client.smartSearch(args);
      return [{ type: 'text', text: JSON.stringify(result, null, 2) }];
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
