/**
 * CredibilityReport.jsx
 *
 * Renders a credibility check result from the orchestrator's JSON output.
 * Props match the shape returned by checkCredibility() in orchestrator-tools.js:
 *   - headlineScore, headlineNote, topic, input, dataSufficiency
 *   - platforms.youtube.videos[].integrityScore / sampleSize / vibeDistribution
 *   - platforms.stackexchange (null if unavailable)
 *   - topFlags[].author / text / botProbability / flagDetails[]
 */

import { useEffect, useRef } from 'react';

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

const FLAG_STYLES = {
  duplicate_text: {
    background: '#2d1f00', color: '#d29922', border: '0.5px solid #5a3e00', label: 'Duplicate text',
  },
  burst_timing: {
    background: '#1a0f2e', color: '#bc8cff', border: '0.5px solid #3d1f6e', label: 'Burst timing',
  },
  generic_phrase: {
    background: '#1f2937', color: '#9ca3af', border: '0.5px solid #374151', label: 'Generic phrase',
  },
  url_or_spam: {
    background: '#2d0f0f', color: '#f87171', border: '0.5px solid #6e1f1f', label: 'URL / spam',
  },
};

function scoreColor(score) {
  if (score == null) return '#6b7280';
  if (score >= 90) return '#2dd4bf';
  if (score >= 70) return '#fbbf24';
  return '#f87171';
}

function ScoreRing({ score, size = 148 }) {
  const arcRef = useRef(null);
  const r = 58;
  const circ = 2 * Math.PI * r;       // 364.4
  const arcLen = circ * 0.75;          // 273.3 (270°)
  const scoreDash = arcLen * ((score ?? 0) / 100);

  useEffect(() => {
    if (!arcRef.current) return;
    // Trigger animation by setting the dasharray after mount
    arcRef.current.style.transition = 'none';
    arcRef.current.setAttribute('stroke-dasharray', `0 ${circ}`);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (arcRef.current) {
          arcRef.current.style.transition = 'stroke-dasharray 1.1s cubic-bezier(0.4,0,0.2,1)';
          arcRef.current.setAttribute('stroke-dasharray', `${scoreDash} ${circ}`);
        }
      });
    });
  }, [score]);

  return (
    <svg width={size} height={size} viewBox="0 0 148 148" role="img" aria-label={`Score ${score} out of 100`}>
      <title>Headline score: {score} / 100</title>
      {/* Track */}
      <circle
        cx="74" cy="74" r={r}
        fill="none" stroke="#374151" strokeWidth="9"
        strokeDasharray={`${arcLen} ${circ}`}
        strokeLinecap="round"
        transform="rotate(135 74 74)"
      />
      {/* Score arc */}
      <circle
        ref={arcRef}
        cx="74" cy="74" r={r}
        fill="none"
        stroke={scoreColor(score)}
        strokeWidth="9"
        strokeDasharray={`0 ${circ}`}
        strokeLinecap="round"
        transform="rotate(135 74 74)"
      />
      <text x="74" y="69" textAnchor="middle" fill="#f9fafb" fontSize="34" fontWeight="500" fontFamily="system-ui, sans-serif">
        {score ?? '—'}
      </text>
      <text x="74" y="88" textAnchor="middle" fill="#9ca3af" fontSize="13" fontFamily="system-ui, sans-serif">
        / 100
      </text>
    </svg>
  );
}

function VibeBar({ percentages, counts }) {
  const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const colors = isDark ? VIBE_COLORS_DARK : VIBE_COLORS_LIGHT;
  const order = ['😐', '😡', '😊', '😂', '🙃'];
  const buckets = order.filter(e => (percentages?.[e] ?? 0) > 0);

  return (
    <div>
      {/* Bar */}
      <div style={{ display: 'flex', height: 28, borderRadius: 6, overflow: 'hidden', gap: 2, marginBottom: 12 }}>
        {buckets.map(emoji => (
          <div
            key={emoji}
            style={{
              flex: percentages[emoji],
              background: colors[emoji],
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              minWidth: percentages[emoji] >= 5 ? 28 : 0,
              overflow: 'hidden',
            }}
          >
            {percentages[emoji] >= 7 && (
              <span style={{ fontSize: 12, fontWeight: 500, color: '#fff' }}>
                {percentages[emoji]}%
              </span>
            )}
          </div>
        ))}
      </div>
      {/* Legend */}
      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
        {buckets.map(emoji => (
          <span key={emoji} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, color: '#9ca3af' }}>
            <span style={{ width: 12, height: 12, borderRadius: 2, background: colors[emoji], flexShrink: 0 }} />
            {emoji} {VIBE_LABELS[emoji]} {percentages[emoji]}%
          </span>
        ))}
      </div>
    </div>
  );
}

function FlagCard({ flag }) {
  const pct = Math.round((flag.botProbability ?? 0) * 100);
  const barColor = pct >= 50 ? '#fbbf24' : '#6b7280';

  return (
    <div style={{
      background: '#161b22',
      border: '0.5px solid #30363d',
      borderRadius: 8,
      padding: '12px 14px',
      display: 'flex',
      gap: 12,
      marginBottom: 8,
    }}>
      <div style={{ minWidth: 44 }}>
        <div style={{ fontSize: 13, fontWeight: 500, color: barColor, fontFamily: 'monospace' }}>
          {flag.botProbability?.toFixed(3)}
        </div>
        <div style={{ height: 3, borderRadius: 2, background: '#30363d', marginTop: 4, overflow: 'hidden' }}>
          <div style={{ width: `${pct}%`, height: '100%', background: barColor }} />
        </div>
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', marginBottom: 6, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 12, color: '#2dd4bf', fontFamily: 'monospace' }}>{flag.author}</span>
          <span style={{ fontSize: 13, color: '#9ca3af', fontStyle: 'italic' }}>"{flag.text}"</span>
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {(flag.flagDetails ?? []).map((d, i) => {
            const s = FLAG_STYLES[d.reason] ?? FLAG_STYLES.generic_phrase;
            return (
              <span key={i} style={{
                fontSize: 11, fontFamily: 'monospace',
                padding: '2px 7px', borderRadius: 4,
                background: s.background, color: s.color, border: s.border,
              }}>
                {s.label}{d.distinctAuthors ? ` ×${d.distinctAuthors}` : ''}
              </span>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function LaneCard({ title, score, available, detail }) {
  return (
    <div style={{
      flex: 1,
      background: '#161b22',
      border: '0.5px solid #30363d',
      borderRadius: 12,
      padding: '16px 18px',
      opacity: available ? 1 : 0.4,
    }}>
      <div style={{ fontSize: 11, letterSpacing: '0.08em', color: '#6b7280', marginBottom: 8 }}>
        {title}
      </div>
      <div style={{ fontSize: 28, fontWeight: 500, color: scoreColor(score), lineHeight: 1 }}>
        {available ? score : '—'}
        {available && <span style={{ fontSize: 13, color: '#6b7280', fontWeight: 400 }}> / 100</span>}
      </div>
      <p style={{ fontSize: 12, color: '#6b7280', margin: '8px 0 0' }}>{detail}</p>
    </div>
  );
}

export default function CredibilityReport({ data }) {
  if (!data) return null;

  const {
    topic,
    input,
    headlineScore,
    headlineNote,
    platforms,
    topFlags,
    dataSufficiency,
  } = data;

  const ytVideos = platforms?.youtube?.videos ?? [];
  const ytVideo = ytVideos[0]; // primary video (URL input) or first of topic results
  const isMultiVideo = ytVideos.length > 1;
  // For topic-string input: use combined vibe if available, else first video's vibe
  const vibe = data.vibeDistribution?.combined ?? ytVideo?.vibeDistribution;
  const se = platforms?.stackexchange;

  // Extract video ID from the input URL for display
  const videoIdMatch = (input ?? '').match(/(?:v=|youtu\.be\/)([A-Za-z0-9_-]{11})/);
  const videoId = videoIdMatch ? videoIdMatch[1] : ytVideo?.videoId ?? '';

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
          Credibility report
        </span>
        <p style={{ fontSize: 24, fontWeight: 500, color: '#e6edf3', margin: '12px 0 4px', lineHeight: 1.3 }}>
          {topic ?? (videoId ? `youtube.com/watch?v=${videoId}` : input)}
        </p>
        {videoId && (
          <p style={{ fontSize: 12, color: '#6b7280', margin: 0, fontFamily: 'monospace' }}>
            youtube.com/watch?v={videoId}
          </p>
        )}
      </div>

      {/* Score ring */}
      <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 4 }}>
        <ScoreRing score={headlineScore} />
      </div>
      {headlineNote && (
        <p style={{ textAlign: 'center', fontSize: 12, color: '#6b7280', margin: '0 0 20px', fontStyle: 'italic' }}>
          {headlineNote}
        </p>
      )}

      {/* Lane cards */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 12 }}>
        <LaneCard
          title="YouTube integrity"
          available={!!ytVideo && !ytVideo.commentsDisabled}
          score={ytVideo?.integrityScore}
          detail={ytVideo?.commentsDisabled
            ? 'Comments disabled on this video'
            : ytVideo
              ? `${ytVideo.sampleSize?.toLocaleString()} comments · ${vibe?.suspiciousCount ?? 0} suspicious`
              : 'No data'}
        />
        <LaneCard
          title="Stack Exchange authority"
          available={!!se}
          score={se?.overallAuthorityScore}
          detail={se
            ? `${se.sampleSize} answers · question ${se.questionId}`
            : 'No relevant question found for this topic'}
        />
      </div>

      {/* Per-video breakdown for topic-string input (multiple videos) */}
      {isMultiVideo && (
        <div style={{
          background: '#161b22',
          border: '0.5px solid #30363d',
          borderRadius: 12,
          padding: '16px 20px',
          marginBottom: 12,
        }}>
          <div style={{ fontSize: 11, letterSpacing: '0.08em', color: '#6b7280', marginBottom: 12 }}>
            Per-video integrity
          </div>
          {ytVideos.map((v, i) => (
            <div key={v.videoId} style={{
              display: 'flex', alignItems: 'center', gap: 12,
              paddingBottom: i < ytVideos.length - 1 ? 10 : 0,
              marginBottom: i < ytVideos.length - 1 ? 10 : 0,
              borderBottom: i < ytVideos.length - 1 ? '0.5px solid #30363d' : 'none',
            }}>
              <div style={{ minWidth: 44, fontSize: 16, fontWeight: 500, color: scoreColor(v.integrityScore) }}>
                {v.integrityScore ?? '—'}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12, color: '#e6edf3', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {v.title ?? v.videoId}
                </div>
                <div style={{ fontSize: 11, color: '#6b7280', marginTop: 2 }}>
                  {v.sampleSize?.toLocaleString()} comments
                  {v.commentsDisabled ? ' · comments disabled' : ''}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Vibe bar */}
      {vibe && (
        <div style={{
          background: '#161b22',
          border: '0.5px solid #30363d',
          borderRadius: 12,
          padding: '18px 20px',
          marginBottom: 12,
        }}>
          <div style={{
            fontSize: 11, letterSpacing: '0.08em', color: '#6b7280',
            marginBottom: 14, display: 'flex', justifyContent: 'space-between',
          }}>
            <span>Comment vibe · {vibe.total?.toLocaleString()} classified</span>
            {(vibe.suspiciousCount ?? 0) > 0 && (
              <span style={{ color: '#fbbf24' }}>🤖 {vibe.suspiciousCount} suspicious</span>
            )}
          </div>
          <VibeBar percentages={vibe.percentages} counts={vibe.counts} />
        </div>
      )}

      {/* Top flags */}
      {topFlags?.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 11, letterSpacing: '0.08em', color: '#6b7280', marginBottom: 10 }}>
            Top flags
          </div>
          {topFlags.map((flag, i) => <FlagCard key={i} flag={flag} />)}
        </div>
      )}

      {/* Footer */}
      <div style={{
        borderTop: '0.5px solid #30363d',
        paddingTop: 12,
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
      }}>
        <span style={{ fontSize: 11, color: '#6b7280' }}>
          Data sufficiency:{' '}
          <span style={{
            color: dataSufficiency === 'full' ? '#2dd4bf' : '#fbbf24',
            fontWeight: 500,
          }}>
            {dataSufficiency}
          </span>
        </span>
        <span style={{ fontSize: 11, color: '#6b7280' }}>nylewebster.com</span>
      </div>
    </div>
  );
}
