import { type Span, SpanStatusCode, trace } from '@opentelemetry/api';

const TRACER_NAME = '@agentscopehq/agent-kit-sdk';

// Matches @opentelemetry/api's AttributeValue shape: primitives plus
// homogeneously-typed arrays with optional null/undefined entries. Keeping
// this in sync with the OTel API avoids type mismatches when attrs are
// forwarded to span.setAttributes. Arrays are mutable to match OTel exactly.
export type SpanAttributeValue =
  | string
  | number
  | boolean
  | Array<string | null | undefined>
  | Array<number | null | undefined>
  | Array<boolean | null | undefined>;

export type SpanAttributes = Record<string, SpanAttributeValue | undefined>;

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
      span.recordException(err instanceof Error ? err : new Error(String(err)));
      throw err;
    } finally {
      span.end();
    }
  });
}
