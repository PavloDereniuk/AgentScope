import { type Span, SpanStatusCode, trace } from '@opentelemetry/api';

const TRACER_NAME = '@agentscope/agent-kit-sdk';

export type SpanAttributes = Record<string, string | number | boolean>;

/**
 * Wraps an async function in an OTel span.
 *
 * @param name      Span name (shows in AgentScope reasoning tree).
 * @param fn        Async function to execute inside the span.
 * @param attrs     Optional span attributes (e.g. solana.mint, trade.amount).
 *
 * @example
 *   const sig = await traced('swap', () => kit.trade(...), {
 *     'solana.mint': mint,
 *     'trade.amount_sol': amount,
 *   });
 */
export async function traced<T>(
  name: string,
  fn: () => Promise<T>,
  attrs?: SpanAttributes,
): Promise<T> {
  const tracer = trace.getTracer(TRACER_NAME);
  return tracer.startActiveSpan(name, async (span: Span) => {
    if (attrs !== undefined) {
      span.setAttributes(attrs);
    }
    try {
      const result = await fn();
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
}
