/**
 * ResearchBrief.jsx
 * Renders the output of research_brief / /research-render.
 *
 * Expected data shape:
 *   topic                  string
 *   goal                   string | undefined
 *   config                 { label, cost, modules[] }   (A/B preset breakdown)
 *   headlineIntegrityScore number | null
 *   videoCount             number
 *   summaries[]            { videoId, title, channel, url, summary, transcriptSource }
 *   videos[]               { credibility: { integrityScore, vibeDistribution } }
 *   playlist               { id, name, added, skipped, failed } | null
 *
 * summaries and videos are parallel arrays — same index = same video.
 *
 * vibeDistribution is the buildVibeDistribution() shape from the server:
 *   { counts, percentages, total, suspiciousCount }, where counts/percentages
 *   are keyed by emoji and percentages are integers 0-100 (not fractions).
 *
 * Styling mirrors CredibilityReport.jsx — inline styles, dark GitHub-ish card
 * palette — so the two viewer modes feel like siblings.
 */

const VIBE_COLORS_LIGHT = {
  '😊': '#1baf7a',
  '😐': '#888780',
  '😡': '#e34948',
  '😂': '#eda100',
  '🙃': '#4a3aa7',
};

const VIBE_COLORS_DARK = {
  '😊': '#199e70',
  '😐': '#898781',
  '😡': '#e66767',
  '😂': '#c98500',
  '🙃': '#9085e9',
};

const VIBE_LABELS = {
  '😊': 'Positive',
  '😐': 'Neutral',
  '😡': 'Negative',
  '😂': 'Humorous',
  '🙃': 'Sarcastic',
};

function scoreColor(score) {
  if (score == null) return '#6b7280';
  if (score >= 90) return '#2dd4bf';
  if (score >= 70) return '#fbbf24';
  return '#f87171';
}

// One-line natural-language read of a comment section's sentiment, derived from
// the percentages (no API call). Answers the "what does this distribution mean"
// gap — the bars alone don't say whether a section is hostile, mixed, or warm.
function vibeSummary(distribution) {
  const pct = distribution?.percentages;
  if (!pct) return null;
  const ranked = Object.entries(pct).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  if (!ranked.length) return null;

  const [e1, p1] = ranked[0];
  const lead = p1 >= 50 ? `Mostly ${VIBE_LABELS[e1] ?? e1}` : `${VIBE_LABELS[e1] ?? e1}-leaning`;
  let s = `${lead} (${p1}%)`;

  const sec = ranked[1];
  if (sec && sec[1] >= 20)      s += `, with significant ${VIBE_LABELS[sec[0]] ?? sec[0]} (${sec[1]}%)`;
  else if (sec && sec[1] >= 10) s += `, some ${VIBE_LABELS[sec[0]] ?? sec[0]} (${sec[1]}%)`;
  return s + '.';
}

// Segmented horizontal bar + legend — same treatment as CredibilityReport's
// VibeBar. percentages are emoji-keyed integers (0-100).
function VibeBar({ percentages }) {
  const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const colors = isDark ? VIBE_COLORS_DARK : VIBE_COLORS_LIGHT;
  const order = ['😐', '😡', '😊', '😂', '🙃'];
  const buckets = order.filter(e => (percentages?.[e] ?? 0) > 0);
  if (!buckets.length) return null;

  return (
    <div>
      <div style={{ display: 'flex', height: 24, borderRadius: 6, overflow: 'hidden', gap: 2, marginBottom: 10 }}>
        {buckets.map(emoji => (
          <div
            key={emoji}
            style={{
              flex: percentages[emoji],
              background: colors[emoji],
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              minWidth: percentages[emoji] >= 5 ? 24 : 0, overflow: 'hidden',
            }}
          >
            {percentages[emoji] >= 8 && (
              <span style={{ fontSize: 11, fontWeight: 500, color: '#fff' }}>{percentages[emoji]}%</span>
            )}
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        {buckets.map(emoji => (
          <span key={emoji} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: '#9ca3af' }}>
            <span style={{ width: 10, height: 10, borderRadius: 2, background: colors[emoji], flexShrink: 0 }} />
            {emoji} {VIBE_LABELS[emoji]} {percentages[emoji]}%
          </span>
        ))}
      </div>
    </div>
  );
}

const CARD = {
  background: '#161b22',
  border: '0.5px solid #30363d',
  borderRadius: 12,
  padding: '16px 18px',
};
const SECTION_LABEL = { fontSize: 11, letterSpacing: '0.08em', color: '#6b7280', marginBottom: 8 };

// Labeled, per-module config the brief ran under — the explicit A/B surface.
function BriefConfig({ config }) {
  if (!config) return null;
  const cost = config.cost;
  return (
    <div style={{ ...CARD, marginBottom: 12 }}>
      <div style={{ ...SECTION_LABEL, display: 'flex', justifyContent: 'space-between', marginBottom: 10 }}>
        <span>Config · {config.label}</span>
        {cost && (
          <span style={{ color: '#9ca3af' }} title={cost.basis}>
            ~${Number(cost.estimateUsd).toFixed(2)} vibe cost
            {cost.vibeCommentsClassified ? ` · ${cost.vibeCommentsClassified.toLocaleString()} comments` : ''}
          </span>
        )}
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {config.modules.map((m) => (
          <span
            key={m.key}
            title={m.effect}
            style={{
              fontSize: 11, fontFamily: 'monospace',
              padding: '3px 9px', borderRadius: 5,
              background: '#1f2937', color: '#9ca3af', border: '0.5px solid #374151',
            }}
          >
            {m.label}: <strong style={{ color: '#e6edf3' }}>{m.value}</strong>
            {m.cost ? ` · ${m.cost}` : ''}
          </span>
        ))}
      </div>
    </div>
  );
}

function LaneCard({ label, children, available = true }) {
  return (
    <div style={{ ...CARD, flex: 1, opacity: available ? 1 : 0.4 }}>
      <div style={SECTION_LABEL}>{label}</div>
      {children}
    </div>
  );
}

function VideoCard({ card }) {
  const cred = card.credibility;
  const dist = cred?.vibeDistribution;
  const summary = dist ? vibeSummary(dist) : null;

  return (
    <div style={{ ...CARD, marginBottom: 12 }}>
      {/* Title + channel */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 10, marginBottom: 8, flexWrap: 'wrap' }}>
        <a
          href={card.url ?? `https://youtu.be/${card.videoId}`}
          target="_blank" rel="noreferrer"
          style={{ fontSize: 15, fontWeight: 500, color: '#2dd4bf', textDecoration: 'none', flex: 1, minWidth: 0 }}
        >
          {card.title ?? card.videoId}
        </a>
        {card.channel && (
          <span style={{ fontSize: 12, color: '#6b7280', whiteSpace: 'nowrap' }}>{card.channel}</span>
        )}
      </div>

      {/* Integrity score */}
      {cred?.integrityScore != null ? (
        <div style={{ fontSize: 13, marginBottom: 12 }}>
          <span style={{ color: '#6b7280' }}>Integrity </span>
          <span style={{ color: scoreColor(cred.integrityScore), fontWeight: 500 }}>
            {cred.integrityScore}
          </span>
          <span style={{ color: '#6b7280' }}> / 100</span>
        </div>
      ) : cred?.commentsDisabled ? (
        <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 12, fontStyle: 'italic' }}>
          Comments disabled — integrity unavailable
        </div>
      ) : null}

      {/* Summary */}
      {card.summary && (
        <p style={{ fontSize: 14, lineHeight: 1.6, color: '#c9d1d9', margin: '0 0 12px' }}>
          {card.summary}
        </p>
      )}

      {/* Transcript source chip */}
      {card.transcriptSource && (
        <div style={{ marginBottom: dist ? 12 : 0 }}>
          <span style={{
            fontSize: 11, fontFamily: 'monospace', color: '#6b7280',
            padding: '2px 8px', borderRadius: 4, background: '#0d1117', border: '0.5px solid #30363d',
          }}>
            transcript: {card.transcriptSource}
          </span>
        </div>
      )}

      {/* Vibe — takeaway + suspicious count + bar */}
      {dist && (
        <div style={{ background: '#0d1117', border: '0.5px solid #30363d', borderRadius: 8, padding: '12px 14px' }}>
          <div style={{ ...SECTION_LABEL, display: 'flex', justifyContent: 'space-between', marginBottom: 10 }}>
            <span>Comment vibe · {dist.total?.toLocaleString()} classified</span>
            {(dist.suspiciousCount ?? 0) > 0 && (
              <span style={{ color: '#fbbf24' }}>🤖 {dist.suspiciousCount} suspicious</span>
            )}
          </div>
          {summary && (
            <p style={{ fontSize: 13, color: '#e6edf3', margin: '0 0 12px' }}>{summary}</p>
          )}
          <VibeBar percentages={dist.percentages} />
        </div>
      )}
    </div>
  );
}

export default function ResearchBrief({ data }) {
  if (!data) return null;

  const {
    topic,
    goal,
    config,
    headlineIntegrityScore,
    videoCount,
    summaries = [],
    videos    = [],
    playlist,
  } = data;

  // Merge parallel arrays into one object per card (same index = same video).
  const cards = summaries.map((s, i) => ({ ...s, credibility: videos[i]?.credibility ?? null }));

  return (
    <div style={{
      background: '#0d1117',
      color: '#e6edf3',
      fontFamily: 'system-ui, -apple-system, sans-serif',
      padding: '32px 28px',
      borderRadius: 16,
      maxWidth: 700,
      margin: '0 auto',
      boxSizing: 'border-box',
    }}>
      {/* Header */}
      <div style={{ textAlign: 'center', marginBottom: 20 }}>
        <span style={{
          fontSize: 12, letterSpacing: '0.12em',
          color: '#2dd4bf', background: 'rgba(45,212,191,0.1)',
          border: '0.5px solid rgba(45,212,191,0.3)',
          borderRadius: 6, padding: '4px 12px', display: 'inline-block',
        }}>
          Research brief
        </span>
        <p style={{ fontSize: 24, fontWeight: 500, color: '#e6edf3', margin: '12px 0 4px', lineHeight: 1.3 }}>
          {topic}
        </p>
        {goal && (
          <p style={{ fontSize: 13, color: '#9ca3af', margin: 0 }}>Goal: {goal}</p>
        )}
      </div>

      {/* Headline lanes: avg integrity + playlist */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 12 }}>
        <LaneCard label="Avg integrity" available={headlineIntegrityScore != null}>
          <div style={{ fontSize: 28, fontWeight: 500, color: scoreColor(headlineIntegrityScore), lineHeight: 1 }}>
            {headlineIntegrityScore ?? '—'}
            <span style={{ fontSize: 13, color: '#6b7280', fontWeight: 400 }}> / 100</span>
          </div>
          <p style={{ fontSize: 12, color: '#6b7280', margin: '8px 0 0' }}>
            across {videoCount} video{videoCount !== 1 ? 's' : ''}
          </p>
        </LaneCard>

        <LaneCard label="Playlist" available={!!playlist?.id}>
          {playlist?.id ? (
            <>
              <a
                href={`https://www.youtube.com/playlist?list=${playlist.id}`}
                target="_blank" rel="noreferrer"
                style={{ fontSize: 15, fontWeight: 500, color: '#2dd4bf', textDecoration: 'none' }}
              >
                {playlist.name ?? 'View playlist'} ↗
              </a>
              <p style={{ fontSize: 12, color: '#6b7280', margin: '8px 0 0' }}>
                {playlist.added ?? 0} added
                {playlist.skipped ? ` · ${playlist.skipped} already in` : ''}
              </p>
            </>
          ) : (
            <p style={{ fontSize: 13, color: '#6b7280', margin: 0 }}>No playlist built</p>
          )}
        </LaneCard>
      </div>

      {/* A/B config */}
      <BriefConfig config={config} />

      {/* Per-video cards */}
      {cards.map((card, i) => <VideoCard key={card.videoId ?? i} card={card} />)}

      {/* Footer */}
      <div style={{
        borderTop: '0.5px solid #30363d', paddingTop: 12, marginTop: 4,
        display: 'flex', justifyContent: 'flex-end',
      }}>
        <span style={{ fontSize: 11, color: '#6b7280' }}>nylewebster.com</span>
      </div>
    </div>
  );
}
