/**
 * vibe-classifier.js
 *
 * Classifies YouTube comments into one of six sentiment buckets using
 * the Claude API in batches of 50. The 🤖 bucket is NOT produced here —
 * that comes from the integrity lane's botProbability threshold (≥0.5)
 * and is applied by the orchestrator when assembling the final output.
 * This module only classifies tone/sentiment.
 *
 * Six buckets:
 *   😊  positive   — praise, excitement, gratitude, genuine enthusiasm
 *   😐  neutral    — questions, factual observations, comparisons
 *   😡  negative   — criticism, anger, disappointment, skepticism
 *   😂  humorous   — jokes, memes, puns, genuinely funny one-liners
 *   🙃  sarcastic  — dry humor, irony, backhanded praise ("great idea"),
 *                    "tech bro snark" — meaningfully different from 😂
 *   🤖  suspicious — NOT assigned here; applied externally by orchestrator
 *
 * Why Claude API instead of rule-based:
 * YouTube comment sections are heavily sarcastic ("great video 👍" can be
 * genuine OR deeply sarcastic), meme-y, and full of dry criticism using
 * positive-sounding words. Rule-based classifiers fail on exactly these
 * cases and produce authoritative-looking but wrong distributions. At
 * ~30 batches for 1,500 comments, the cost is pennies per check — worth
 * it for accuracy on the thing the vibe bar is actually supposed to show.
 */

const BATCH_SIZE = 50;

const BUCKETS = ['😊', '😐', '😡', '😂', '🙃'];

const SYSTEM_PROMPT = `You are a comment sentiment classifier. You will receive a JSON array of YouTube comments. Classify each comment into EXACTLY one of these five categories:

😊 positive   — genuine praise, excitement, gratitude, enthusiasm
😐 neutral    — questions, factual observations, comparisons, info-seeking
😡 negative   — criticism, anger, disappointment, skepticism, complaints
😂 humorous   — jokes, puns, memes, genuinely funny one-liners
🙃 sarcastic  — dry humor, irony, backhanded praise, snark (e.g. "great idea genius", "wow so cheap 🙃", "definitely worth $1000")

Key distinction: 😂 is genuinely funny; 🙃 is funny-but-pointed or ironic. "lol imagine paying $1000 for this" is 🙃, not 😂. A real pun or wordplay is 😂.

Respond ONLY with a valid JSON array of single emoji strings, one per input comment, in the same order as the input. No explanation, no markdown, no backticks. Example for 3 comments: ["😊","🙃","😐"]`;

/**
 * Classify one batch of up to BATCH_SIZE comments.
 * Returns an array of emoji strings in the same order as the input.
 * Falls back to '😐' for any comment that can't be classified.
 */
async function classifyBatch(commentTexts) {
  const body = JSON.stringify({
    model: 'claude-sonnet-4-6',
    max_tokens: 1000,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: JSON.stringify(commentTexts.map((t, i) => ({ i, text: t.slice(0, 280) })))
      }
    ]
  });

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Vibe classifier API error ${res.status}: ${text}`);
  }

  const data = await res.json();
  const raw = data.content?.find(b => b.type === 'text')?.text?.trim() ?? '[]';

  let parsed;
  try {
    // Strip any accidental markdown fences before parsing
    const clean = raw.replace(/```json|```/g, '').trim();
    parsed = JSON.parse(clean);
  } catch {
    console.error('[vibe-classifier] Failed to parse batch response:', raw.slice(0, 200));
    parsed = [];
  }

  // Validate and fill gaps — never let a bad API response blow up the caller
  return commentTexts.map((_, i) => {
    const v = parsed[i];
    return BUCKETS.includes(v) ? v : '😐';
  });
}

/**
 * Classify an array of comment objects, adding a `vibe` field to each.
 * Processes in BATCH_SIZE chunks. Returns the same array with vibe added.
 *
 * Comments whose botProbability is already ≥0.5 still get a sentiment
 * classification here — the orchestrator overlays 🤖 on top when building
 * the final distribution, keeping the two lanes cleanly independent.
 *
 * @param {Array<{ text: string, [key: string]: any }>} comments
 * @returns {Promise<Array<{ text: string, vibe: string, [key: string]: any }>>}
 */
export async function classifyCommentVibes(comments) {
  const results = [...comments];

  for (let i = 0; i < comments.length; i += BATCH_SIZE) {
    const batch = comments.slice(i, i + BATCH_SIZE);
    const vibes = await classifyBatch(batch.map(c => c.text ?? ''));
    for (let j = 0; j < batch.length; j++) {
      results[i + j] = { ...results[i + j], vibe: vibes[j] };
    }
    // Small pause between batches — not strictly required but avoids any
    // rate-limit pressure on rapid large calls.
    if (i + BATCH_SIZE < comments.length) {
      await new Promise(r => setTimeout(r, 100));
    }
  }

  return results;
}

/**
 * Summarize a classified comment array into a vibe distribution object.
 * Returns counts and percentages per bucket, plus the 🤖 count separately
 * (derived from botProbability ≥ 0.5, not from sentiment classification).
 *
 * @param {Array<{ vibe: string, botProbability?: number }>} classifiedComments
 * @returns {{ counts: object, percentages: object, total: number, suspiciousCount: number }}
 */
export function buildVibeDistribution(classifiedComments) {
  const counts = Object.fromEntries(BUCKETS.map(b => [b, 0]));
  let suspiciousCount = 0;

  for (const c of classifiedComments) {
    if (BUCKETS.includes(c.vibe)) counts[c.vibe]++;
    if ((c.botProbability ?? 0) >= 0.5) suspiciousCount++;
  }

  const total = classifiedComments.length;
  const percentages = Object.fromEntries(
    BUCKETS.map(b => [b, total > 0 ? Math.round((counts[b] / total) * 100) : 0])
  );

  return { counts, percentages, total, suspiciousCount };
}

export { BUCKETS, BATCH_SIZE };
