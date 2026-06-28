// Thin client for the server's POST /credibility-render endpoint.
//
// The request goes to the same-origin /api path; Vite's dev proxy
// (see vite.config.js) rewrites it to /credibility-render on the MCP server
// and injects the Authorization: Bearer <RENDER_TOKEN> header server-side.
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
