/**
 * LLM-judged search relevance + auto-refinement, using Claude Haiku (cheap,
 * fast — this is a simple classification task, not a job that needs a
 * bigger model). Optional: if ANTHROPIC_API_KEY isn't set, callers should
 * skip straight to a plain, unrefined search instead.
 */

const API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-haiku-4-5-20251001';

export function refinerAvailable() {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

/**
 * Asks Claude whether a set of search results actually match the stated
 * goal, and if not, asks it to propose a better query. Returns parsed JSON:
 * { verdict: 'good'|'refine', relevantCount, refinedQuery, reasoning }
 */
async function judgeResults(goal, query, results) {
  const resultList = results
    .map((r, i) => `${i + 1}. "${r.title}" — ${r.channel}`)
    .join('\n');

  const prompt =
    `A user wants YouTube videos matching this goal: "${goal}"\n` +
    `The search query used was: "${query}"\n` +
    `Here are the top results:\n${resultList}\n\n` +
    `Judge how many of these genuinely match the goal (not just keyword overlap — ` +
    `actual topical relevance). If fewer than half are relevant, propose a better ` +
    `search query that would surface more on-topic results.\n\n` +
    `Respond ONLY with JSON, no other text:\n` +
    `{"verdict": "good"|"refine", "relevantCount": <number>, "refinedQuery": <string or null>, "reasoning": "<one short sentence>"}`;

  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 300,
      messages: [{ role: 'user', content: prompt }]
    })
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));

  const text = data.content?.[0]?.text || '';
  try {
    return JSON.parse(text.trim());
  } catch {
    // Fail soft: if Claude doesn't return clean JSON, treat as "good enough"
    // rather than crashing the whole search.
    console.error(`[query-refiner] could not parse judge response, treating as good: ${text}`);
    return { verdict: 'good', relevantCount: results.length, refinedQuery: null, reasoning: 'parse_failed' };
  }
}

/**
 * Runs the search-judge-refine loop. yt.search must already be bound;
 * this just orchestrates the judgment + retry logic around it.
 */
export async function smartSearch(yt, { query, goal, count = 10, order = 'relevance', maxAttempts = 3 }) {
  let currentQuery = query;
  const attempts = [];
  let results = [];

  for (let i = 0; i < maxAttempts; i++) {
    results = await yt.search(currentQuery, count, order);
    const judgment = await judgeResults(goal, currentQuery, results);
    attempts.push({ query: currentQuery, resultCount: results.length, ...judgment });

    if (judgment.verdict === 'good' || !judgment.refinedQuery) {
      break;
    }
    currentQuery = judgment.refinedQuery;
  }

  return { results, attempts, finalQuery: currentQuery };
}
