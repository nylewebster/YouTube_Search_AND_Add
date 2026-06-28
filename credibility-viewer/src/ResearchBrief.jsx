/**
 * ResearchBrief.jsx
 * Renders the output of research_brief / /research-render.
 *
 * Expected data shape:
 *   topic                  string
 *   goal                   string | undefined
 *   headlineIntegrityScore number | null
 *   videoCount             number
 *   summaries[]            { videoId, title, channel, url, summary, transcriptSource }
 *   videos[]               { credibility: { integrityScore, vibeDistribution } }
 *   playlist               string (playlist ID) | null
 *
 * summaries and videos are parallel arrays — same index = same video.
 */

const VIBE_EMOJI = {
  positive:  '😊',
  neutral:   '😐',
  negative:  '😡',
  humorous:  '😂',
  sarcastic: '🙃',
  bot:       '🤖',
};

const VIBE_LABEL = {
  positive:  'Positive',
  neutral:   'Neutral',
  negative:  'Negative',
  humorous:  'Humorous',
  sarcastic: 'Sarcastic',
  bot:       'Bot-like',
};

function scoreColor(score) {
  if (score >= 70) return '#4ade80';
  if (score >= 40) return '#facc15';
  return '#f87171';
}

function VibeBars({ distribution }) {
  if (!distribution) return null;
  const entries = Object.entries(distribution).filter(([, v]) => v > 0);
  if (entries.length === 0) return <p className="brief__no-vibe">No vibe data</p>;

  return (
    <div className="brief__vibe">
      {entries.map(([key, pct]) => (
        <div key={key} className="brief__vibe-row">
          <span className="brief__vibe-emoji">{VIBE_EMOJI[key] ?? '?'}</span>
          <span className="brief__vibe-label">{VIBE_LABEL[key] ?? key}</span>
          <div className="brief__vibe-bar-track">
            <div
              className="brief__vibe-bar-fill"
              style={{ width: `${Math.round(pct * 100)}%` }}
            />
          </div>
          <span className="brief__vibe-pct">{Math.round(pct * 100)}%</span>
        </div>
      ))}
    </div>
  );
}

export default function ResearchBrief({ data }) {
  const {
    topic,
    goal,
    headlineIntegrityScore,
    videoCount,
    summaries = [],
    videos    = [],
    playlist,
  } = data;

  // Merge parallel arrays into one object per card
  const cards = summaries.map((s, i) => ({
    ...s,
    credibility: videos[i]?.credibility ?? null,
  }));

  return (
    <div className="brief">
      {/* ── Brief header ── */}
      <div className="brief__header">
        <h2 className="brief__topic">{topic}</h2>
        {goal && <p className="brief__goal">Goal: {goal}</p>}

        <div className="brief__meta">
          <span className="brief__count">
            {videoCount} video{videoCount !== 1 ? 's' : ''}
          </span>

          {headlineIntegrityScore != null && (
            <span
              className="brief__headline-score"
              style={{ color: scoreColor(headlineIntegrityScore) }}
            >
              Avg integrity: {headlineIntegrityScore}/100
            </span>
          )}

          {playlist && (
            <a
              className="brief__playlist-link"
              href={`https://www.youtube.com/playlist?list=${playlist}`}
              target="_blank"
              rel="noreferrer"
            >
              View playlist ↗
            </a>
          )}
        </div>
      </div>

      {/* ── Per-video cards ── */}
      <div className="brief__cards">
        {cards.map((card, i) => (
          <div key={card.videoId ?? i} className="brief__card">

            {/* Card header: title + channel */}
            <div className="brief__card-header">
              <a
                className="brief__card-title"
                href={card.url ?? `https://youtu.be/${card.videoId}`}
                target="_blank"
                rel="noreferrer"
              >
                {card.title ?? card.videoId}
              </a>
              {card.channel && (
                <span className="brief__card-channel">{card.channel}</span>
              )}
            </div>

            {/* Integrity score badge */}
            {card.credibility?.integrityScore != null && (
              <div
                className="brief__card-score"
                style={{ color: scoreColor(card.credibility.integrityScore) }}
              >
                Integrity: {card.credibility.integrityScore}/100
              </div>
            )}

            {/* Summary */}
            {card.summary && (
              <p className="brief__card-summary">{card.summary}</p>
            )}

            {/* Transcript source */}
            {card.transcriptSource && (
              <p className="brief__card-source">
                Transcript: <em>{card.transcriptSource}</em>
              </p>
            )}

            {/* Collapsible vibe distribution */}
            {card.credibility?.vibeDistribution && (
              <details className="brief__card-vibe-details">
                <summary className="brief__card-vibe-summary">
                  Vibe distribution
                </summary>
                <VibeBars distribution={card.credibility.vibeDistribution} />
              </details>
            )}

          </div>
        ))}
      </div>
    </div>
  );
}
