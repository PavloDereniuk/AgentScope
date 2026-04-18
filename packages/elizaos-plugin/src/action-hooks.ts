import { type Attributes, type Span, SpanStatusCode, trace } from '@opentelemetry/api';
import type { Action, ActionHandler } from './types.js';

const TRACER_NAME = '@agentscope/elizaos-plugin';

/**
 * Base58 Solana signature format. Mirrors the regex the API's OTLP
 * receiver uses before persisting `solana.tx.signature` attributes —
 * rejecting obvious garbage at the SDK boundary spares the receiver
 * work and makes "my signature didn't show up" easier to debug.
 */
const SOLANA_SIG_RE = /^[1-9A-HJ-NP-Za-km-z]{32,88}$/;

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
    return tracer.startActiveSpan(action.name, async (span: Span) => {
      const attrs: Attributes = { 'action.name': action.name };
      const input = message.content.text;
      if (typeof input === 'string' && input.length > 0) {
        attrs['reasoning.input'] = input;
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
