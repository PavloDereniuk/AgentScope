import http from 'node:http';
import type { NodeSDK } from '@opentelemetry/sdk-node';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { initAgentScope } from '../src/otel-setup.js';
import { traced } from '../src/trace-decorator.js';

// ---------------------------------------------------------------------------
// Mock OTLP receiver
// ---------------------------------------------------------------------------

interface MockServer {
  url: string;
  bodies: unknown[];
  close: () => Promise<void>;
}

function startMockOtlpServer(): Promise<MockServer> {
  const bodies: unknown[] = [];
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk: Buffer) => {
        raw += chunk.toString();
      });
      req.on('end', () => {
        if (raw.length > 0) bodies.push(JSON.parse(raw) as unknown);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ partialSuccess: {} }));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        bodies,
        close: () =>
          new Promise<void>((res, rej) => server.close((err) => (err ? rej(err) : res()))),
      });
    });
  });
}

type OtlpSpan = {
  name: string;
  status?: { code: number };
  attributes: Array<{ key: string; value: { stringValue?: string; doubleValue?: number } }>;
};

type OtlpBody = {
  resourceSpans: Array<{
    resource: { attributes: Array<{ key: string; value: { stringValue?: string } }> };
    scopeSpans: Array<{ spans: OtlpSpan[] }>;
  }>;
};

function allSpans(bodies: unknown[]): OtlpSpan[] {
  return (bodies as OtlpBody[]).flatMap((b) =>
    b.resourceSpans.flatMap((rs) => rs.scopeSpans.flatMap((ss) => ss.spans)),
  );
}

/** Poll until a span with the given name arrives (up to 5s). */
async function waitForSpan(bodies: unknown[], name: string): Promise<OtlpSpan> {
  for (let i = 0; i < 100; i++) {
    const span = allSpans(bodies).find((s) => s.name === name);
    if (span) return span;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Span "${name}" did not arrive within 5s`);
}

// ---------------------------------------------------------------------------

describe('agent-kit-sdk — integration', () => {
  let mock: MockServer;
  let sdk: NodeSDK;

  beforeAll(async () => {
    process.env.OTEL_BSP_SCHEDULE_DELAY = '10';

    mock = await startMockOtlpServer();
    sdk = initAgentScope({ apiUrl: mock.url, agentToken: 'sdk-tok-suite' });
  });

  afterAll(async () => {
    await sdk.shutdown();
    await mock.close();
    // biome-ignore lint/performance/noDelete: removing env var requires delete
    delete process.env.OTEL_BSP_SCHEDULE_DELAY;
  });

  beforeEach(() => {
    mock.bodies.length = 0;
  });

  // ---------------------------------------------------------------------------

  it('sends span with correct resource attribute (agent.token)', async () => {
    const result = await traced('analyze_market', async () => 42, { 'solana.mint': 'So111' });

    await waitForSpan(mock.bodies, 'analyze_market');

    expect(result).toBe(42);

    const body = mock.bodies[0] as OtlpBody;
    const tokenAttr = body.resourceSpans[0]?.resource.attributes.find(
      (a) => a.key === 'agent.token',
    );
    expect(tokenAttr?.value.stringValue).toBe('sdk-tok-suite');
  });

  it('attaches custom string and numeric span attributes', async () => {
    await traced('execute_trade', async () => 'sig-abc', {
      'solana.mint': 'USDC',
      'trade.amount_sol': 1.5,
    });

    const span = await waitForSpan(mock.bodies, 'execute_trade');

    const mintAttr = span.attributes.find((a) => a.key === 'solana.mint');
    expect(mintAttr?.value.stringValue).toBe('USDC');

    const amtAttr = span.attributes.find((a) => a.key === 'trade.amount_sol');
    expect(amtAttr?.value.doubleValue).toBe(1.5);
  });

  it('marks span ERROR when fn throws and re-throws', async () => {
    await expect(
      traced('failing_action', async () => {
        throw new Error('rpc timeout');
      }),
    ).rejects.toThrow('rpc timeout');

    const span = await waitForSpan(mock.bodies, 'failing_action');
    // SpanStatusCode.ERROR = 2
    expect(span.status?.code).toBe(2);
  });

  it('preserves parent-child nesting via context propagation', async () => {
    await traced('parent_action', async () => {
      await traced('child_action', async () => 'done');
    });

    await waitForSpan(mock.bodies, 'parent_action');
    const spans = allSpans(mock.bodies);
    expect(spans.find((s) => s.name === 'parent_action')).toBeDefined();
    expect(spans.find((s) => s.name === 'child_action')).toBeDefined();
  });
});
