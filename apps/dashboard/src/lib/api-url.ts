/**
 * Resolves an API path into a fully-qualified URL.
 *
 * - In local dev (VITE_API_BASE_URL unset) we return the path unchanged
 *   so the Vite dev-proxy in `vite.config.ts` forwards `/api/*` and
 *   `/v1/*` to the API on localhost:3000 — no CORS needed.
 * - In production (VITE_API_BASE_URL=https://agentscope-api-...up.railway.app)
 *   we prefix the path so the browser issues a cross-origin request
 *   directly against Railway. The API's CORS middleware whitelists the
 *   dashboard origin(s) so the browser lets the response through.
 *
 * Previously the dashboard relied on Vercel catching `/api/*` and
 * serving it — but Vercel's SPA catch-all rewrite was returning
 * `index.html` for every non-asset path, so POSTs got a 405 and GETs
 * parsed HTML as JSON. A runtime-resolved base URL avoids that class
 * of bug at the source.
 */

const RAW_BASE = import.meta.env.VITE_API_BASE_URL ?? '';
// Strip trailing slash so callers can keep passing leading-slash paths
// without producing `https://host//api/agents`.
const BASE = RAW_BASE.replace(/\/+$/, '');

export function resolveApiUrl(path: string): string {
  // Callers always pass absolute paths (starting with '/') — keep that
  // contract so a missing leading slash fails loud rather than
  // producing a surprising `${BASE}api/agents` concatenation.
  if (!path.startsWith('/')) {
    throw new Error(`resolveApiUrl: path must start with '/', got ${path}`);
  }
  return BASE + path;
}

/**
 * Returns the absolute public API origin to embed in user-facing
 * snippets (Quickstart copy/paste). In dev (no VITE_API_BASE_URL) the
 * dashboard talks to the API through the Vite proxy, so BASE is empty;
 * we fall back to the local API origin so the snippet remains runnable
 * outside the browser.
 */
export function getPublicApiUrl(): string {
  return BASE || 'http://localhost:3000';
}
