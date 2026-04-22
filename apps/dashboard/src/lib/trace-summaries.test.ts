import { describe, expect, it } from 'vitest';
import { type ReasoningLogLike, summarizeTraces } from './trace-summaries';

function log(
  partial: Partial<ReasoningLogLike> & { spanId: string; traceId: string },
): ReasoningLogLike {
  return {
    parentSpanId: null,
    agentId: 'agent-1',
    spanName: 'span',
    startTime: '2026-04-22T10:00:00.000Z',
    endTime: '2026-04-22T10:00:01.000Z',
    attributes: null,
    ...partial,
  };
}

describe('summarizeTraces', () => {
  it('returns [] for empty input', () => {
    expect(summarizeTraces([])).toEqual([]);
  });

  it('groups spans by traceId and counts them', () => {
    const summaries = summarizeTraces([
      log({ spanId: 'a', traceId: 't1' }),
      log({ spanId: 'b', traceId: 't1', parentSpanId: 'a' }),
      log({ spanId: 'c', traceId: 't2' }),
    ]);
    const t1 = summaries.find((s) => s.traceId === 't1');
    const t2 = summaries.find((s) => s.traceId === 't2');
    expect(t1?.spanCount).toBe(2);
    expect(t2?.spanCount).toBe(1);
  });

  it('uses the parent-less span as the root', () => {
    const summaries = summarizeTraces([
      log({ spanId: 'child', traceId: 't', spanName: 'child', parentSpanId: 'root' }),
      log({ spanId: 'root', traceId: 't', spanName: 'execute_swap' }),
    ]);
    expect(summaries[0]?.rootSpanName).toBe('execute_swap');
  });

  it('computes duration as max(endTime) − min(startTime)', () => {
    const summaries = summarizeTraces([
      log({
        spanId: 'a',
        traceId: 't',
        startTime: '2026-04-22T10:00:00.000Z',
        endTime: '2026-04-22T10:00:00.200Z',
      }),
      log({
        spanId: 'b',
        traceId: 't',
        parentSpanId: 'a',
        startTime: '2026-04-22T10:00:00.100Z',
        endTime: '2026-04-22T10:00:00.350Z',
      }),
    ]);
    expect(summaries[0]?.durationMs).toBe(350);
  });

  it('marks a trace as errored when any span has otel.status_code === 2', () => {
    const summaries = summarizeTraces([
      log({ spanId: 'a', traceId: 't', attributes: { 'otel.status_code': 0 } }),
      log({ spanId: 'b', traceId: 't', attributes: { 'otel.status_code': 2 } }),
    ]);
    expect(summaries[0]?.hasError).toBe(true);
  });

  it('also accepts the string form ERROR for otel.status_code', () => {
    const summaries = summarizeTraces([
      log({ spanId: 'a', traceId: 't', attributes: { 'otel.status_code': 'ERROR' } }),
    ]);
    expect(summaries[0]?.hasError).toBe(true);
  });

  it('sorts traces newest-first by startTime', () => {
    const summaries = summarizeTraces([
      log({ spanId: 'a', traceId: 'older', startTime: '2026-04-22T09:00:00.000Z' }),
      log({ spanId: 'b', traceId: 'newer', startTime: '2026-04-22T11:00:00.000Z' }),
    ]);
    expect(summaries.map((s) => s.traceId)).toEqual(['newer', 'older']);
  });

  it('returns durationMs === null when no span has an endTime', () => {
    const summaries = summarizeTraces([log({ spanId: 'a', traceId: 't', endTime: null })]);
    expect(summaries[0]?.durationMs).toBeNull();
  });
});
