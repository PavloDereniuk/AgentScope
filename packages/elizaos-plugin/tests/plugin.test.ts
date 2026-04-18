import http from 'node:http';
import type { NodeSDK } from '@opentelemetry/sdk-node';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { wrapAction } from '../src/action-hooks.js';
import { createSdk } from '../src/otel-exporter.js';
import type { Action } from '../src/types.js';

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
  attributes: Array<{ key: string; value: { stringValue?: string } }>;
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
// Suite — one NodeSDK instance shared to avoid OTel global state conflicts.
// ---------------------------------------------------------------------------

describe('elizaos-plugin — integration', () => {
  let mock: MockServer;
  let sdk: NodeSDK;

  beforeAll(async () => {
    // Shortest possible batch delay so spans ship quickly even under load
    process.env.OTEL_BSP_SCHEDULE_DELAY = '10';

    mock = await startMockOtlpServer();
    sdk = createSdk({ apiUrl: mock.url, agentToken: 'tok-suite' });
    sdk.start();
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

  it('sends a span with correct resource attribute and span name', async () => {
    const action: Action = {
      name: 'TRADE_SOL',
      description: 'Execute a SOL trade',
      similes: [],
      examples: [],
      validate: async () => true,
      handler: async () => true,
    };

    const result = await wrapAction(action).handler(
      { agentId: 'agent-001', character: { name: 'TradingBot' } },
      { content: { text: 'Buy 1 SOL' }, userId: 'user-001' },
    );

    const span = await waitForSpan(mock.bodies, 'TRADE_SOL');

    expect(result).toBe(true);

    const body = mock.bodies[0] as OtlpBody;
    const tokenAttr = body.resourceSpans[0]?.resource.attributes.find(
      (a) => a.key === 'agent.token',
    );
    expect(tokenAttr?.value.stringValue).toBe('tok-suite');

    const actionAttr = span.attributes.find((a) => a.key === 'action.name');
    expect(actionAttr?.value.stringValue).toBe('TRADE_SOL');
  });

  it('sets span status ERROR when action throws', async () => {
    const action: Action = {
      name: 'FAIL_ACTION',
      description: 'Always fails',
      similes: [],
      examples: [],
      validate: async () => true,
      handler: async () => {
        throw new Error('simulated failure');
      },
    };

    await expect(
      wrapAction(action).handler(
        { agentId: 'agent-002', character: { name: 'BrokenBot' } },
        { content: { text: 'Do something' }, userId: 'user-002' },
      ),
    ).rejects.toThrow('simulated failure');

    const span = await waitForSpan(mock.bodies, 'FAIL_ACTION');
    // SpanStatusCode.ERROR = 2
    expect(span.status?.code).toBe(2);
  });

  it('attaches solana.tx.signature when provided in options', async () => {
    const action: Action = {
      name: 'SWAP',
      description: 'Token swap',
      similes: [],
      examples: [],
      validate: async () => true,
      handler: async () => true,
    };

    await wrapAction(action).handler(
      { agentId: 'agent-003', character: { name: 'SwapBot' } },
      { content: { text: 'Swap USDC→SOL' }, userId: 'user-003' },
      undefined,
      { 'solana.tx.signature': '5xyzAbcDef1234567892abcdefGHJKLM' },
    );

    const span = await waitForSpan(mock.bodies, 'SWAP');
    const sigAttr = span.attributes.find((a) => a.key === 'solana.tx.signature');
    expect(sigAttr?.value.stringValue).toBe('5xyzAbcDef1234567892abcdefGHJKLM');
  });
});
