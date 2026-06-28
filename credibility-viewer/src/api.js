// Thin client for the server's POST /credibility-render and /research-render
// endpoints.
//
// Requests go to the same-origin /api path; Vite's dev proxy (see
// vite.config.js) rewrites them to the matching path on the MCP server and
// injects the Authorization: Bearer <RENDER_TOKEN> header server-side.
// No token is present in this client code.

export async function postCredibility(input, includeVibe) {
  const body = { input };
  if (typeof includeVibe === 'boolean') body.includeVibe = includeVibe;

  const res = await fetch('/api/credibility-render', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  let data;
  try {
    data = await res.json();
  } catch {
    data = null;
  }

  if (!res.ok) {
    const message = data?.error || `Request failed (${res.status} ${res.statusText})`;
    throw new Error(message);
  }

  return data;
}

// A/B presets for the Research Brief mode. Mirrors VIBE_PRESETS in
// src/research-brief-tools.js — keep keys in sync. The server is the source of
// truth for what each preset actually does; these labels just drive the selector.
export const BRIEF_PRESETS = [
  { key: 'full', label: 'Full — vibe on, deep sample (1500)' },
  { key: 'lite', label: 'Lite — vibe on, shallow sample (500)' },
  { key: 'off',  label: 'Off — no vibe' },
];

export async function postResearch({ topic, goal, videoCount, vibeMode }) {
  const body = { topic };
  if (goal)                           body.goal = goal;
  if (typeof videoCount === 'number') body.videoCount = videoCount;
  if (vibeMode)                       body.vibeMode = vibeMode;

  const res = await fetch('/api/research-render', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  let data;
  try {
    data = await res.json();
  } catch {
    data = null;
  }

  if (!res.ok) {
    const message = data?.error || `Request failed (${res.status} ${res.statusText})`;
    throw new Error(message);
  }

  return data;
}
