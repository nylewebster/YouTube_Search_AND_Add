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

export async function postResearch({ topic, goal, videoCount, includeVibe }) {
  const body = { topic };
  if (goal)                             body.goal = goal;
  if (typeof videoCount === 'number')   body.videoCount = videoCount;
  if (typeof includeVibe === 'boolean') body.includeVibe = includeVibe;

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
