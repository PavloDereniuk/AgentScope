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

/**
 * Validate VITE_API_BASE_URL at module load. The value is embedded into
 * user-facing copy/paste snippets (curl, agent-kit) via getPublicApiUrl,
 * and into every fetch issued by the dashboard. A typo or
 * `javascript:`/`data:` value would silently break onboarding or, worse,
 * end up rendered inside a curl example. Mirrors the
 * resolveLandingUrl pattern used for VITE_LANDING_URL.
 *
 * Empty input is the canonical "use Vite dev-proxy" signal — never a
 * misconfiguration. We only fall back (with a console.warn) when the
 * value is non-empty but unparseable or has a non-http(s) protocol.
 */
function resolveApiBase(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const trimmed = raw.replace(/\/+$/, '');
  if (trimmed === '') return '';
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      console.warn(
        `[api-url] VITE_API_BASE_URL has invalid protocol "${parsed.protocol}", falling back to dev proxy`,
      );
      return '';
    }
    return trimmed;
  } catch {
    console.warn(
      `[api-url] VITE_API_BASE_URL is not a valid URL ("${raw}"), falling back to dev proxy`,
    );
    return '';
  }
}

const BASE = resolveApiBase(import.meta.env.VITE_API_BASE_URL);

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
