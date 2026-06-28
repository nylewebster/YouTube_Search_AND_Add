import { useState } from 'react';
import { postCredibility, postResearch, BRIEF_PRESETS } from './api.js';
import CredibilityReport from './CredibilityReport.jsx';
import ResearchBrief from './ResearchBrief.jsx';

export default function App() {
  const [mode, setMode] = useState('credibility'); // 'credibility' | 'brief'

  // Credibility state
  const [credInput, setCredInput]       = useState('');
  const [credIncludeVibe, setCredIncludeVibe] = useState(true);
  const [credReport, setCredReport]     = useState(null);

  // Research brief state
  const [briefTopic, setBriefTopic]           = useState('');
  const [briefGoal, setBriefGoal]             = useState('');
  const [briefVideoCount, setBriefVideoCount] = useState(3);
  const [briefVibeMode, setBriefVibeMode]     = useState('full'); // A/B preset; 'full' = vibe on
  const [briefResult, setBriefResult]         = useState(null);

  // Shared
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState(null);

  function switchMode(newMode) {
    setMode(newMode);
    setError(null);
  }

  async function onCredSubmit(e) {
    e.preventDefault();
    const trimmed = credInput.trim();
    if (!trimmed || loading) return;
    setLoading(true);
    setError(null);
    setCredReport(null);
    try {
      const result = await postCredibility(trimmed, credIncludeVibe);
      setCredReport(result);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function onBriefSubmit(e) {
    e.preventDefault();
    const trimmed = briefTopic.trim();
    if (!trimmed || loading) return;
    setLoading(true);
    setError(null);
    setBriefResult(null);
    try {
      const result = await postResearch({
        topic: trimmed,
        goal: briefGoal.trim() || undefined,
        videoCount: briefVideoCount,
        vibeMode: briefVibeMode,
      });
      setBriefResult(result);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="app">
      <header className="app__header">
        <h1>Credibility Viewer</h1>

        <div className="app__tabs">
          <button
            className={`app__tab${mode === 'credibility' ? ' app__tab--active' : ''}`}
            onClick={() => switchMode('credibility')}
          >
            Credibility Check
          </button>
          <button
            className={`app__tab${mode === 'brief' ? ' app__tab--active' : ''}`}
            onClick={() => switchMode('brief')}
          >
            Research Brief
          </button>
        </div>

        <p className="app__subtitle">
          {mode === 'credibility'
            ? 'Enter a YouTube URL or a topic to run a credibility check.'
            : 'Enter a topic to generate a full research brief with video summaries and credibility scores.'}
        </p>
      </header>

      {mode === 'credibility' && (
        <form className="form" onSubmit={onCredSubmit}>
          <input
            className="form__input"
            type="text"
            value={credInput}
            onChange={(e) => setCredInput(e.target.value)}
            placeholder='https://youtu.be/… or a topic like "RTX 5070 Ti review"'
            autoFocus
          />
          <button
            className="form__submit"
            type="submit"
            disabled={loading || !credInput.trim()}
          >
            {loading ? 'Checking…' : 'Check'}
          </button>
          <label className="form__checkbox">
            <input
              type="checkbox"
              checked={credIncludeVibe}
              onChange={(e) => setCredIncludeVibe(e.target.checked)}
            />
            Include vibe classification
          </label>
        </form>
      )}

      {mode === 'brief' && (
        <form className="form" onSubmit={onBriefSubmit}>
          <input
            className="form__input"
            type="text"
            value={briefTopic}
            onChange={(e) => setBriefTopic(e.target.value)}
            placeholder='Topic, e.g. "RTX 5070 Ti performance"'
            autoFocus
          />
          <input
            className="form__input"
            type="text"
            value={briefGoal}
            onChange={(e) => setBriefGoal(e.target.value)}
            placeholder='Goal (optional), e.g. "buying decision"'
          />
          <label className="form__label">
            Videos to include:
            <input
              className="form__number"
              type="number"
              min={1}
              max={10}
              value={briefVideoCount}
              onChange={(e) => setBriefVideoCount(Number(e.target.value))}
            />
          </label>
          <label className="form__label">
            Config:
            <select
              className="form__select"
              value={briefVibeMode}
              onChange={(e) => setBriefVibeMode(e.target.value)}
            >
              {BRIEF_PRESETS.map((p) => (
                <option key={p.key} value={p.key}>{p.label}</option>
              ))}
            </select>
          </label>
          <button
            className="form__submit"
            type="submit"
            disabled={loading || !briefTopic.trim()}
          >
            {loading ? 'Generating brief…' : 'Generate Brief'}
          </button>
        </form>
      )}

      {loading && (
        <p className="status">
          {mode === 'credibility'
            ? 'Running credibility check… this can take a while (fetches comments and classifies them).'
            : 'Generating research brief… this can take several minutes (transcribes and summarizes videos).'}
        </p>
      )}

      {error && (
        <div className="status status--error">
          <strong>Error:</strong> {error}
        </div>
      )}

      {mode === 'credibility' && credReport  && <CredibilityReport data={credReport} />}
      {mode === 'brief'       && briefResult && <ResearchBrief data={briefResult} />}
    </div>
  );
}
