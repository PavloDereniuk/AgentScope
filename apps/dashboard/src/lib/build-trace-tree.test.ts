import { describe, expect, it } from 'vitest';
import {
  type TraceSpan,
  buildTraceTree,
  partitionAttributes,
  spanDurationMs,
  spanKindLabel,
  statusCodeLabel,
} from './build-trace-tree';

function span(overrides: Partial<TraceSpan> & Pick<TraceSpan, 'spanId'>): TraceSpan {
  return {
    id: overrides.spanId,
    traceId: 'aaaa0000aaaa0000aaaa0000aaaa0000',
    spanId: overrides.spanId,
    parentSpanId: overrides.parentSpanId ?? null,
    spanName: overrides.spanName ?? `span-${overrides.spanId}`,
    startTime: overrides.startTime ?? '2026-04-30T12:00:00.000Z',
    endTime: overrides.endTime ?? '2026-04-30T12:00:01.000Z',
    attributes: overrides.attributes ?? {},
    txSignature: overrides.txSignature ?? null,
  };
}

describe('buildTraceTree', () => {
  it('builds a forest from flat spans', () => {
    const tree = buildTraceTree([
      span({ spanId: '1' }),
      span({ spanId: '2', parentSpanId: '1' }),
      span({ spanId: '3', parentSpanId: '1' }),
      span({ spanId: '4', parentSpanId: '2' }),
    ]);
    expect(tree).toHaveLength(1);
    expect(tree[0]?.span.spanId).toBe('1');
    expect(tree[0]?.children).toHaveLength(2);
    const sub = tree[0]?.children.find((c) => c.span.spanId === '2');
    expect(sub?.children[0]?.span.spanId).toBe('4');
  });

  it('promotes spans whose parent is missing from the input to roots', () => {
    // Out-of-window trim: the actual root span isn't in the result set.
    const tree = buildTraceTree([
      span({ spanId: '2', parentSpanId: 'missing' }),
      span({ spanId: '3', parentSpanId: '2' }),
    ]);
    expect(tree).toHaveLength(1);
    expect(tree[0]?.span.spanId).toBe('2');
    expect(tree[0]?.children[0]?.span.spanId).toBe('3');
  });

  it('treats a self-referential parent as a root (no infinite recursion)', () => {
    const tree = buildTraceTree([span({ spanId: '1', parentSpanId: '1' })]);
    expect(tree).toHaveLength(1);
    expect(tree[0]?.children).toHaveLength(0);
  });

  it('breaks transitive cycles by promoting cycle members to roots', () => {
    // A → B → C → A — pathological but observed; renderer must stay finite.
    const tree = buildTraceTree([
      span({ spanId: 'A', parentSpanId: 'C' }),
      span({ spanId: 'B', parentSpanId: 'A' }),
      span({ spanId: 'C', parentSpanId: 'B' }),
    ]);
    // Every span is in the cycle → all become roots.
    expect(tree.map((n) => n.span.spanId).sort()).toEqual(['A', 'B', 'C']);
  });
});

describe('spanDurationMs', () => {
  it('returns ms between start and end', () => {
    expect(
      spanDurationMs({
        startTime: '2026-04-30T12:00:00.000Z',
        endTime: '2026-04-30T12:00:01.500Z',
      }),
    ).toBe(1500);
  });

  it('clamps negative durations to 0 (clock skew)', () => {
    expect(
      spanDurationMs({
        startTime: '2026-04-30T12:00:01.000Z',
        endTime: '2026-04-30T12:00:00.000Z',
      }),
    ).toBe(0);
  });
});

describe('spanKindLabel / statusCodeLabel', () => {
  it('maps known OTel SpanKind values', () => {
    expect(spanKindLabel(0)).toBe('unspecified');
    expect(spanKindLabel(1)).toBe('internal');
    expect(spanKindLabel(3)).toBe('client');
  });

  it('returns null for non-numeric kind', () => {
    expect(spanKindLabel('client')).toBeNull();
    expect(spanKindLabel(undefined)).toBeNull();
  });

  it('maps OTel status codes', () => {
    expect(statusCodeLabel(0)).toBe('unset');
    expect(statusCodeLabel(1)).toBe('ok');
    expect(statusCodeLabel(2)).toBe('error');
    expect(statusCodeLabel(99)).toBeNull();
  });
});

describe('partitionAttributes', () => {
  it('separates OTel-reserved keys from user attributes', () => {
    const part = partitionAttributes({
      'otel.kind': 1,
      'otel.status_code': 2,
      'otel.status_message': 'boom',
      'reasoning.input': 'hi',
      count: 42,
    });
    expect(part.kind).toBe('internal');
    expect(part.status).toBe('error');
    expect(part.statusMessage).toBe('boom');
    expect(part.user).toEqual({ 'reasoning.input': 'hi', count: 42 });
  });

  it('returns nulls when reserved keys are absent', () => {
    const part = partitionAttributes({ foo: 'bar' });
    expect(part.kind).toBeNull();
    expect(part.status).toBeNull();
    expect(part.statusMessage).toBeNull();
    expect(part.user).toEqual({ foo: 'bar' });
  });
});
