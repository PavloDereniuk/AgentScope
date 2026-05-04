/**
 * Minimal Server-Sent Events client over `fetch` + ReadableStream.
 *
 * Why not the `eventsource` npm package?
 *   - Native `fetch` in Node 24 already streams response bodies — no extra
 *     dependency needed and the install footprint stays tiny (CLIs are
 *     `npx`-able, every transitive dep slows cold start).
 *   - `eventsource` doesn't support custom headers across all Node versions,
 *     and we need `Authorization: Bearer ...` to authenticate.
 *
 * Reconnect strategy: on network errors or non-2xx, the caller decides via
 * the supplied `onError`. We surface failures verbatim instead of silently
 * retrying — a tail-style CLI should print the failure and exit so the
 * dev sees something is wrong rather than a frozen stream.
 *
 * Wire format we parse:
 *
 *     data: {"type":"tx.new",...}\n\n
 *     : keepalive\n\n
 *
 * Comment lines (start with `:`) are dropped. Multi-line `data:` is folded
 * by joining on `\n`, per the SSE spec — though our server never emits
 * multi-line frames, so this is forward-defensive only.
 */

export interface SseClientOptions {
  url: string;
  headers: Record<string, string>;
  signal?: AbortSignal;
  onMessage: (data: string) => void;
  onOpen?: () => void;
}

const TEXT_DECODER = new TextDecoder('utf-8');

export async function streamSse(opts: SseClientOptions): Promise<void> {
  const fetchOpts: RequestInit = {
    method: 'GET',
    headers: {
      Accept: 'text/event-stream',
      ...opts.headers,
    },
  };
  if (opts.signal) {
    fetchOpts.signal = opts.signal;
  }
  const response = await fetch(opts.url, fetchOpts);

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    const trimmed = body.length > 200 ? `${body.slice(0, 200)}…` : body;
    throw new Error(`HTTP ${response.status} ${response.statusText} — ${trimmed}`);
  }

  if (!response.body) {
    throw new Error('response had no body');
  }

  opts.onOpen?.();

  const reader = response.body.getReader();
  let buffer = '';
  // Read until the server (or the abort signal) closes the connection.
  // The for-loop pattern is intentional: a `while (true) { ... break }`
  // would obscure the exit condition.
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buffer += TEXT_DECODER.decode(value, { stream: true });

    // SSE frames are separated by a blank line (`\n\n`). Process whole
    // frames; keep the trailing partial chunk in the buffer for the next
    // read.
    let separator = buffer.indexOf('\n\n');
    while (separator !== -1) {
      const frame = buffer.slice(0, separator);
      buffer = buffer.slice(separator + 2);
      const data = parseFrame(frame);
      if (data !== null) opts.onMessage(data);
      separator = buffer.indexOf('\n\n');
    }
  }
}

/**
 * Extract the `data:` payload from a single SSE frame. Returns null for
 * comment-only frames (keepalives) and for frames without a data field.
 */
function parseFrame(frame: string): string | null {
  const lines = frame.split('\n');
  const dataLines: string[] = [];
  for (const line of lines) {
    if (line.startsWith(':')) continue; // comment
    if (line.startsWith('data:')) {
      // SSE allows an optional space after `data:` — strip it.
      const rest = line.slice(5);
      dataLines.push(rest.startsWith(' ') ? rest.slice(1) : rest);
    }
    // Other field types (event:, id:, retry:) are unused by our server,
    // so we ignore them. A future server change is the only reason to
    // care.
  }
  if (dataLines.length === 0) return null;
  return dataLines.join('\n');
}
