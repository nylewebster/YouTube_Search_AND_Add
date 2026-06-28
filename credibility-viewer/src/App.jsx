import { useState } from 'react';
import { postCredibility } from './api.js';
import CredibilityReport from './CredibilityReport.jsx';

export default function App() {
  const [input, setInput] = useState('');
  const [includeVibe, setIncludeVibe] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [report, setReport] = useState(null);

  async function onSubmit(e) {
    e.preventDefault();
    const trimmed = input.trim();
    if (!trimmed || loading) return;

    setLoading(true);
    setError(null);
    setReport(null);
    try {
      const result = await postCredibility(trimmed, includeVibe);
      setReport(result);
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
        <p className="app__subtitle">
          Enter a YouTube URL or a topic to run a credibility check.
        </p>
      </header>

      <form className="form" onSubmit={onSubmit}>
        <input
          className="form__input"
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="https://youtu.be/… or a topic like “RTX 5070 Ti review”"
          autoFocus
        />
        <button className="form__submit" type="submit" disabled={loading || !input.trim()}>
          {loading ? 'Checking…' : 'Check'}
        </button>
        <label className="form__checkbox">
          <input
            type="checkbox"
            checked={includeVibe}
            onChange={(e) => setIncludeVibe(e.target.checked)}
          />
          Include vibe classification
        </label>
      </form>

      {loading && (
        <p className="status">
          Running credibility check… this can take a while (fetches comments and
          classifies them).
        </p>
      )}

      {error && (
        <div className="status status--error">
          <strong>Error:</strong> {error}
        </div>
      )}

      {report && <CredibilityReport data={report} />}
    </div>
  );
}
