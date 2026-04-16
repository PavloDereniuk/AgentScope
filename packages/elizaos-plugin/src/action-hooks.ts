import { type Span, SpanStatusCode, trace } from '@opentelemetry/api';
import type { Action, ActionHandler } from './types.js';

const TRACER_NAME = '@agentscope/elizaos-plugin';

/**
 * Wraps a single ElizaOS action's handler in an OTel span.
 *
 * Span attributes:
 *   action.name         — action identifier
 *   reasoning.input     — message text sent to the action
 *   reasoning.agent_id  — runtime.agentId
 *   solana.tx.signature — optional, from options['solana.tx.signature']
 */
export function wrapAction(action: Action): Action {
  const original: ActionHandler = action.handler;

  const wrapped: ActionHandler = async (runtime, message, state, options, callback) => {
    const tracer = trace.getTracer(TRACER_NAME);
    return tracer.startActiveSpan(action.name, async (span: Span) => {
      span.setAttributes({
        'action.name': action.name,
        'reasoning.input': message.content.text,
        'reasoning.agent_id': runtime.agentId,
      });

      const sig = options?.['solana.tx.signature'];
      if (typeof sig === 'string' && sig.length > 0) {
        span.setAttribute('solana.tx.signature', sig);
      }

      try {
        const result = await original(runtime, message, state, options, callback);
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (err) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: String(err) });
        span.recordException(err as Error);
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
