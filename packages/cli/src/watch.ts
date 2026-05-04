/**
 * `agentscope watch <agent-id>` — connect to the per-agent SSE stream
 * and tail every event the bus publishes for that agent.
 *
 * Composition: argv → SSE GET request → parse frame → render → stdout.
 * The CLI exits when the stream closes, when fetch throws, or when the
 * user sends SIGINT/SIGTERM. We return a numeric exit code rather than
 * calling `process.exit` directly so tests can drive the function.
 */

import type { WatchArgs } from './args.js';
import { parseEvent } from './events.js';
import { renderConnectBanner, renderEvent } from './render.js';
import { streamSse } from './sse-client.js';

export interface WatchDeps {
  /** Where to print rendered output. Defaults to `process.stdout.write`. */
  out: (line: string) => void;
  /** Where to print errors. Defaults to `process.stderr.write`. */
  err: (line: string) => void;
}

/**
 * Run the watch loop. Returns an exit code:
 *   0 — stream closed cleanly (e.g. SIGINT after the abort signal fires)
 *   1 — fatal error (HTTP non-2xx, network failure, malformed URL)
 */
export async function runWatch(args: WatchArgs, deps: WatchDeps): Promise<number> {
  const url = buildStreamUrl(args.apiUrl, args.agentId);
  const banner = renderConnectBanner(args.agentId, args.apiUrl, { color: args.color });
  deps.out(`${banner}\n`);

  const controller = new AbortController();
  const onSignal = () => controller.abort();
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  try {
    await streamSse({
      url,
      headers: { Authorization: `Bearer ${args.token}` },
      signal: controller.signal,
      onMessage: (data) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(data);
        } catch {
          // A malformed frame is not fatal — log it once and keep tailing.
          deps.err(`! malformed frame: ${data}\n`);
          return;
        }
        const event = parseEvent(parsed);
        if (!event) return;
        const line = renderEvent(event, { color: args.color });
        if (line !== null) deps.out(`${line}\n`);
      },
    });
    return 0;
  } catch (err) {
    if (controller.signal.aborted) {
      // Ctrl+C is a clean shutdown, not a failure.
      return 0;
    }
    const message = err instanceof Error ? err.message : String(err);
    deps.err(`error: ${message}\n`);
    return 1;
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
}

/**
 * Build the per-agent SSE URL by trimming a trailing slash from the user's
 * API origin. Keeps the join idempotent so `--api https://x/` and
 * `--api https://x` both produce the same URL.
 */
export function buildStreamUrl(apiUrl: string, agentId: string): string {
  const base = apiUrl.endsWith('/') ? apiUrl.slice(0, -1) : apiUrl;
  return `${base}/v1/agents/${encodeURIComponent(agentId)}/stream`;
}
