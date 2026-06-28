/**
 * stackexchange-tools.js
 *
 * Mirrors youtube-tools.js: exports createStackExchangeClient(),
 * toolDefinitions (flat array), and handleToolCall(client, name, args).
 *
 * Docs: https://api.stackexchange.com/docs
 * Auth: none required for read-only use.
 *   - No key:    300 requests/day/IP
 *   - With key:  10,000 requests/day (free — register at
 *     https://stackapps.com/apps/oauth/register, then set
 *     STACKEXCHANGE_API_KEY as a Railway env var)
 */

const SE_API_BASE = 'https://api.stackexchange.com/2.3';

function stripHtml(html = '') {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

export function createStackExchangeClient() {
  const apiKey = process.env.STACKEXCHANGE_API_KEY || null;

  // In-memory cache for the site list — ~180 sites that almost never
  // change. Fetching this on every call that needs site context (e.g.
  // the smart search's site-selection step) would waste quota and add
  // latency for no benefit. Cache persists for the lifetime of the
  // server process; a Railway redeploy clears it naturally.
  let _siteCache = null;

  // SE API responses are gzip-encoded server-side regardless of
  // Accept-Encoding. Node 18+ fetch() auto-decompresses, so res.json()
  // just works as-is.
  async function seFetch(path, params = {}) {
    const url = new URL(`${SE_API_BASE}${path}`);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, v);
    }
    if (apiKey) url.searchParams.set('key', apiKey);

    const res = await fetch(url.toString());
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Stack Exchange API error ${res.status}: ${text}`);
    }

    const data = await res.json();
    if (data.error_id) {
      throw new Error(`SE API error ${data.error_id}: ${data.error_message}`);
    }
    if (data.backoff) {
      console.error(`[stackexchange] backoff of ${data.backoff}s requested — throttle next call.`);
    }
    return data;
  }

  return {
    async listSites({ limit = 100 } = {}) {
      // Return cached result if available — site list rarely changes and
      // costs a quota unit every time it's fetched fresh.
      if (_siteCache) {
        console.error('[stackexchange] listSites: returning cached site list');
        return _siteCache;
      }

      // No custom filter here on purpose — compiled SE filter strings are
      // opaque IDs you can only get back from SE's /filters/create endpoint,
      // they can't be hand-written. The default response already includes
      // name/api_site_parameter/audience/site_url, so we just pick those out.
      const data = await seFetch('/sites', { pagesize: limit });
      _siteCache = data.items.map((s) => ({
        name: s.name,
        site: s.api_site_parameter,
        audience: s.audience,
        url: s.site_url,
      }));
      console.error(`[stackexchange] listSites: fetched and cached ${_siteCache.length} sites`);
      return _siteCache;
    },

    async searchQuestions({ query, tags, site = 'stackoverflow', sort = 'relevance', limit = 10 }) {
      const data = await seFetch('/search/advanced', {
        q: query,
        tagged: tags,
        site,
        sort,
        order: 'desc',
        pagesize: limit,
        filter: 'withbody',
      });
      return data.items.map((q) => ({
        id: q.question_id,
        title: q.title,
        score: q.score,
        answerCount: q.answer_count,
        isAnswered: q.is_answered,
        tags: q.tags,
        link: q.link,
        excerpt: stripHtml(q.body).slice(0, 400),
      }));
    },

    async getAnswers({ questionId, site = 'stackoverflow', limit = 10 }) {
      const data = await seFetch(`/questions/${questionId}/answers`, {
        site,
        sort: 'votes',
        order: 'desc',
        pagesize: limit,
        filter: 'withbody',
      });
      return data.items.map((a) => ({
        id: a.answer_id,
        score: a.score,
        isAccepted: a.is_accepted,
        body: stripHtml(a.body),
        ownerReputation: a.owner?.reputation ?? null,
        creationDate: a.creation_date ?? null,
      }));
    },

    /**
     * Search for tags that actually exist on a given SE site by partial
     * name match. Used by the smart search's tag discovery step to confirm
     * candidate terms before building a tagged query — guessed tags that
     * don't exist on the target site silently return no results.
     *
     * Costs 1 quota unit per call. No cap on candidate terms by design —
     * accuracy matters more than quota here given the 10k/day budget.
     *
     * @param {string} inname - partial tag name to search for
     * @param {string} site - SE site slug
     * @param {number} limit - max tags to return (default 5)
     */
    async searchTags({ inname, site = 'stackoverflow', limit = 5 }) {
      const data = await seFetch('/tags', {
        inname,
        site,
        sort: 'popular',
        order: 'desc',
        pagesize: limit,
      });
      return (data.items || []).map((t) => ({
        name: t.name,
        count: t.count, // question count — useful for knowing how established a tag is
      }));
    },
  };
}

export const toolDefinitions = [
  {
    name: 'stackexchange_list_sites',
    description:
      "List all available Stack Exchange network sites — Stack Overflow for programming, Arqade for gaming, Super User for computing, Skeptics for fact-checking, Cooking, Parenting, Music, and ~180 others. Use this to discover the right site slug before searching with stackexchange_search or stackexchange_smart_search. Results include each site's name, api_site_parameter slug, audience description, and URL.",
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'stackexchange_search',
    description:
      "Search Stack Exchange questions by free-text query and/or tags on a given site. Defaults to Stack Overflow; pass a different `site` (e.g. 'parenting', 'cooking', 'arqade') for non-programming topics.",
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Free-text search query' },
        tags: { type: 'string', description: "Semicolon-separated tags, e.g. 'python;async'" },
        site: { type: 'string', description: "SE site slug, e.g. 'stackoverflow', 'parenting'" },
        limit: { type: 'number', description: 'Max results (default 10)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'stackexchange_get_answers',
    description:
      'Get the full answer thread for a specific question ID, sorted by votes, including which answer (if any) was accepted.',
    inputSchema: {
      type: 'object',
      properties: {
        questionId: { type: 'number', description: 'The question_id from a search result' },
        site: { type: 'string', description: "SE site slug matching the question's site" },
        limit: { type: 'number', description: 'Max answers to return (default 10)' },
      },
      required: ['questionId'],
    },
  },
];

export async function handleToolCall(client, name, args) {
  switch (name) {
    case 'stackexchange_list_sites': {
      const sites = await client.listSites(args ?? {});
      return [{ type: 'text', text: JSON.stringify(sites, null, 2) }];
    }
    case 'stackexchange_search': {
      const results = await client.searchQuestions(args);
      return [{ type: 'text', text: JSON.stringify(results, null, 2) }];
    }
    case 'stackexchange_get_answers': {
      const answers = await client.getAnswers(args);
      return [{ type: 'text', text: JSON.stringify(answers, null, 2) }];
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
