/**
 * Integration tests for GET /metrics (B.5 — Prometheus endpoint).
 *
 * Covers: correct Content-Type, well-formed Prometheus text, zero-baseline
 * output, tx_total per agent, alerts_total by rule × severity,
 * reasoning_spans_total, and ingest_lag presence after a tx is inserted.
 */

import { agentTransactions, alerts } from '@agentscope/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/index';
import type { AuthVerifier } from '../src/lib/auth-verifier';
import { createSseBus } from '../src/lib/sse-bus';
import { type TestDatabase, createTestDatabase } from './helpers/test-db';

const tokenVerifier: AuthVerifier = {
  async verify(token: string) {
    return { userId: token };
  },
};

function bearer(did: string) {
  return { Authorization: `Bearer ${did}` };
}

interface TestApp {
  app: ReturnType<typeof buildApp>;
  testDb: TestDatabase;
}

async function setup(): Promise<TestApp> {
  const testDb = await createTestDatabase();
  const app = buildApp({
    db: testDb.db,
    verifier: tokenVerifier,
    sseBus: createSseBus(),
  });
  return { app, testDb };
}

async function createAgent(ctx: TestApp, did: string, name: string): Promise<string> {
  const res = await ctx.app.request('/api/agents', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...bearer(did),
    },
    body: JSON.stringify({
      walletPubkey: 'So11111111111111111111111111111111111111112',
      name,
      framework: 'custom',
      agentType: 'other',
    }),
  });
  if (res.status !== 201) throw new Error(`seed failed: ${res.status}`);
  const body = (await res.json()) as { agent: { id: string } };
  return body.agent.id;
}

describe('GET /metrics', () => {
  let ctx: TestApp;
  beforeEach(async () => {
    ctx = await setup();
  });
  afterEach(async () => {
    await ctx.testDb.close();
  });

  it('returns 200 with Prometheus Content-Type', async () => {
    const res = await ctx.app.request('/metrics');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
    expect(res.headers.get('content-type')).toContain('version=0.0.4');
  });

  it('is accessible without authentication', async () => {
    const res = await ctx.app.request('/metrics');
    expect(res.status).toBe(200);
  });

  it('emits required HELP and TYPE headers on empty platform', async () => {
    const res = await ctx.app.request('/metrics');
    const body = await res.text();
    expect(body).toContain('# HELP agentscope_tx_total');
    expect(body).toContain('# TYPE agentscope_tx_total counter');
    expect(body).toContain('# HELP agentscope_alerts_total');
    expect(body).toContain('# TYPE agentscope_alerts_total counter');
    expect(body).toContain('# HELP agentscope_reasoning_spans_total');
    expect(body).toContain('# TYPE agentscope_reasoning_spans_total counter');
    expect(body).toContain('# HELP agentscope_ingest_lag_seconds');
    expect(body).toContain('# TYPE agentscope_ingest_lag_seconds gauge');
  });

  it('reports agentscope_reasoning_spans_total 0 on empty platform', async () => {
    const res = await ctx.app.request('/metrics');
    const body = await res.text();
    expect(body).toContain('agentscope_reasoning_spans_total 0');
  });

  it('increments tx_total per agent after a tx is inserted', async () => {
    const agentId = await createAgent(ctx, 'did:privy:alice', 'Alice');
    await ctx.testDb.db.insert(agentTransactions).values({
      agentId,
      signature: 'sig1',
      slot: 1,
      blockTime: new Date().toISOString(),
      programId: 'Sys1111111111111111111111111111111111111111',
      solDelta: '0',
      success: true,
    });
    await ctx.testDb.db.insert(agentTransactions).values({
      agentId,
      signature: 'sig2',
      slot: 2,
      blockTime: new Date().toISOString(),
      programId: 'Sys1111111111111111111111111111111111111111',
      solDelta: '0',
      success: true,
    });

    const res = await ctx.app.request('/metrics');
    const body = await res.text();
    expect(body).toContain(`agent="${agentId}"`);
    expect(body).toMatch(/agentscope_tx_total\{[^}]*\} 2/);
  });

  it('reflects alerts_total by rule and severity', async () => {
    const agentId = await createAgent(ctx, 'did:privy:bob', 'Bob');
    await ctx.testDb.db.insert(alerts).values({
      agentId,
      ruleName: 'slippage_spike',
      severity: 'critical',
      dedupeKey: 'k1',
    });
    await ctx.testDb.db.insert(alerts).values({
      agentId,
      ruleName: 'low_balance',
      severity: 'warning',
      dedupeKey: 'k2',
    });

    const res = await ctx.app.request('/metrics');
    const body = await res.text();
    expect(body).toContain('rule="slippage_spike",severity="critical"');
    expect(body).toContain('rule="low_balance",severity="warning"');
    expect(body).toMatch(/agentscope_alerts_total\{[^}]*slippage_spike[^}]*\} 1/);
  });

  it('emits ingest_lag_seconds after a tx exists', async () => {
    const agentId = await createAgent(ctx, 'did:privy:carol', 'Carol');
    await ctx.testDb.db.insert(agentTransactions).values({
      agentId,
      signature: 'sig3',
      slot: 3,
      blockTime: new Date(Date.now() - 5_000).toISOString(),
      programId: 'Sys1111111111111111111111111111111111111111',
      solDelta: '0',
      success: true,
    });

    const res = await ctx.app.request('/metrics');
    const body = await res.text();
    const match = body.match(/agentscope_ingest_lag_seconds (\d+\.\d+)/);
    expect(match).not.toBeNull();
    const lag = Number(match?.[1]);
    expect(lag).toBeGreaterThanOrEqual(0);
  });
});
