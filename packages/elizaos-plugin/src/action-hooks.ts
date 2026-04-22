import { type Attributes, type Span, SpanStatusCode, trace } from '@opentelemetry/api';
import type { Action, ActionHandler } from './types.js';

const TRACER_NAME = '@agentscope/elizaos-plugin';

/**
 * Base58 Solana signature format. Kept in sync with `SOLANA_SIGNATURE_RE`
 * in `@agentscope/shared/signature` — duplicated here (not imported) so
 * the published ElizaOS plugin has zero workspace runtime dependencies.
 * If you change either, change both.
 */
const SOLANA_SIG_RE = /^[1-9A-HJ-NP-Za-km-z]{32,88}$/;

/**
 * Max characters kept from `message.content.text` as the `reasoning.input`
 * span attribute. OTLP receivers soft-cap attribute values around 128 KB
 * and the full OTLP batch around 4 MB; long chat histories can silently
 * break the export. 2048 chars preserves enough for debugging while
 * staying well under every known cap.
 */
const MAX_REASONING_INPUT_CHARS = 2048;

/**
 * Max characters kept for `action.name` as the span name. Matches the
 * common OTel convention for span-name length.
 */
const MAX_SPAN_NAME_CHARS = 128;

/**
 * Wraps a single ElizaOS action's handler in an OTel span.
 *
 * Span attributes:
 *   action.name         — action identifier
 *   reasoning.input     — message text sent to the action (string only)
 *   reasoning.agent_id  — runtime.agentId (string only)
 *   solana.tx.signature — optional, from options['solana.tx.signature'],
 *                         format-validated before attach
 *
 * Defensive: duck-typed runtime/message inputs that supply non-string or
 * undefined values for required attribute fields are dropped instead of
 * being coerced to "undefined" strings.
 */
export function wrapAction(action: Action): Action {
  const original: ActionHandler = action.handler;

  const wrapped: ActionHandler = async (runtime, message, state, options, callback) => {
    const tracer = trace.getTracer(TRACER_NAME);
    // Span name is external runtime input — cap it so a misbehaving plugin
    // can't produce pathologically long span names that receivers reject
    // or dashboards truncate unpredictably.
    const safeActionName = (action.name ?? 'unknown').slice(0, MAX_SPAN_NAME_CHARS);
    return tracer.startActiveSpan(safeActionName, async (span: Span) => {
      const attrs: Attributes = { 'action.name': safeActionName };
      const input = message.content.text;
      if (typeof input === 'string' && input.length > 0) {
        // Truncate to keep individual attribute values well below the
        // per-export payload cap; append a marker so readers can tell
        // the input was trimmed.
        attrs['reasoning.input'] =
          input.length > MAX_REASONING_INPUT_CHARS
            ? `${input.slice(0, MAX_REASONING_INPUT_CHARS)}…[truncated ${input.length - MAX_REASONING_INPUT_CHARS} chars]`
            : input;
      }
      if (typeof runtime.agentId === 'string' && runtime.agentId.length > 0) {
        attrs['reasoning.agent_id'] = runtime.agentId;
      }
      span.setAttributes(attrs);

      const sig = options?.['solana.tx.signature'];
      if (typeof sig === 'string' && SOLANA_SIG_RE.test(sig)) {
        span.setAttribute('solana.tx.signature', sig);
      }

      try {
        const result = await original(runtime, message, state, options, callback);
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (err) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: String(err) });
        span.recordException(err instanceof Error ? err : new Error(String(err)));
        throw err;
      } finally {
        span.end();
      }
    });
  };

  return { ...action, handler: wrapped };
}

/** Wraps every action in the array. */
export function wrapActions(actions: Action[]): Action[] {
  return actions.map(wrapAction);
}
