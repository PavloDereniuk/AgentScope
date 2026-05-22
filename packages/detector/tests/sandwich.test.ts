/**
 * TDD tests for slippage_sandwich rule (post-MVP roadmap A.1, v0.4.0).
 *
 * Evidence-only phase: compare actual on-chain receive amount (from
 * `tokenDeltas`) against the quoted amount embedded in the Jupiter
 * instruction args. If the gap exceeds the threshold, the swap is a
 * sandwich-attack candidate. Phase 2 augments this with slot-neighbour
 * lookup to confirm the front-run; this file stays Phase 1 only.
 */

import type { Database } from '@agentscope/db';
import type { SolanaPubkey, SolanaSignature, TokenDelta } from '@agentscope/shared';
import { describe, expect, it, vi } from 'vitest';
import { sandwichRule } from '../src/rules/sandwich';
import type { NeighbourFetcher, SlotNeighbourTx, TxRuleContext } from '../src/types';

const stubDb = {} as Database;

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' as SolanaPubkey;
const SOL = 'So11111111111111111111111111111111111111112' as SolanaPubkey;
const JUPITER = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';

const defaults = {
  slippagePct: 5,
  gasMult: 3,
  drawdownPct: 10,
  errorRatePct: 20,
  staleMinutes: 30,
  sandwichSlippagePct: 2,
};

function makeTokenDelta(mint: SolanaPubkey, delta: string): TokenDelta {
  return { mint, decimals: 6, delta };
}

function makeTxCtx(overrides: {
  instructionName?: string | null;
  parsedArgs?: Record<string, unknown> | null;
  tokenDeltas?: readonly TokenDelta[];
  agentThreshold?: number;
  fetchSlotNeighbours?: NeighbourFetcher;
  feeLamports?: number;
}): TxRuleContext {
  return {
    agent: {
      id: 'agent-1',
      alertRules: overrides.agentThreshold
        ? { sandwichSlippagePctThreshold: overrides.agentThreshold }
        : {},
    },
    defaults,
    db: stubDb,
    now: new Date('2026-04-09T12:00:00Z'),
    ...(overrides.fetchSlotNeighbours
      ? { fetchSlotNeighbours: overrides.fetchSlotNeighbours }
      : {}),
    transaction: {
      signature: 'sandwich-sig-001' as SolanaSignature,
      slot: 300_000_000,
      instructionName: overrides.instructionName ?? 'jupiter.swap',
      parsedArgs:
        overrides.parsedArgs === undefined
          ? {
              variant: 'route',
              inputMint: SOL,
              outputMint: USDC,
              inAmount: '1000000000', // 1 SOL in
              outAmount: '100000000', // 100 USDC quoted
              slippageBps: 100,
            }
          : overrides.parsedArgs,
      solDelta: '-1.0',
      tokenDeltas: overrides.tokenDeltas ?? [makeTokenDelta(USDC, '100000000')],
      feeLamports: overrides.feeLamports ?? 5000,
      success: true,
      blockTime: '2026-04-09T12:00:00Z',
    },
  };
}

function makeNeighbour(overrides: Partial<SlotNeighbourTx> = {}): SlotNeighbourTx {
  return {
    signature: overrides.signature ?? `neighbour-${Math.random().toString(36).slice(2, 8)}`,
    feeLamports: overrides.feeLamports ?? 10000,
    programIds: overrides.programIds ?? [JUPITER],
    success: overrides.success ?? true,
  };
}

describe('slippage_sandwich rule (Phase 1 — evidence only)', () => {
  it('fires warning when actual receive is below quoted by more than threshold', async () => {
    // Quoted 100 USDC, received 97 USDC → 3% actual slippage, threshold 2% → warning
    const ctx = makeTxCtx({
      tokenDeltas: [makeTokenDelta(USDC, '97000000')],
    });
    const result = await sandwichRule.evaluate(ctx);

    expect(result).not.toBeNull();
    expect(result?.ruleName).toBe('slippage_sandwich');
    expect(result?.severity).toBe('warning');
    expect(result?.payload).toMatchObject({
      thresholdPct: 2,
      quotedOutAmount: '100000000',
      actualOutAmount: '97000000',
      outputMint: USDC,
      signature: 'sandwich-sig-001',
      slot: 300_000_000,
    });
    // actualSlippagePct should round to a stable decimal (3% here).
    expect((result?.payload as { actualSlippagePct: number }).actualSlippagePct).toBeCloseTo(3, 1);
  });

  it('fires critical when actual slippage exceeds 5× threshold', async () => {
    // Quoted 100 USDC, received 85 USDC → 15% actual slippage; threshold 2% → 7.5× → critical
    const ctx = makeTxCtx({
      tokenDeltas: [makeTokenDelta(USDC, '85000000')],
    });
    const result = await sandwichRule.evaluate(ctx);
    expect(result?.severity).toBe('critical');
  });

  it('does not fire when actual matches quoted exactly', async () => {
    const ctx = makeTxCtx({
      tokenDeltas: [makeTokenDelta(USDC, '100000000')],
    });
    const result = await sandwichRule.evaluate(ctx);
    expect(result).toBeNull();
  });

  it('does not fire when actual exceeds quoted (positive slippage)', async () => {
    // Better than expected — never a sandwich.
    const ctx = makeTxCtx({
      tokenDeltas: [makeTokenDelta(USDC, '101000000')],
    });
    const result = await sandwichRule.evaluate(ctx);
    expect(result).toBeNull();
  });

  it('does not fire when actual slippage is within threshold', async () => {
    // 1% slippage, threshold 2% → null
    const ctx = makeTxCtx({
      tokenDeltas: [makeTokenDelta(USDC, '99000000')],
    });
    const result = await sandwichRule.evaluate(ctx);
    expect(result).toBeNull();
  });

  it('skips non-Jupiter instructions', async () => {
    const ctx = makeTxCtx({
      instructionName: 'kamino.deposit',
      tokenDeltas: [makeTokenDelta(USDC, '50000000')],
    });
    const result = await sandwichRule.evaluate(ctx);
    expect(result).toBeNull();
  });

  it('skips when parsedArgs is null', async () => {
    const ctx = makeTxCtx({ parsedArgs: null });
    const result = await sandwichRule.evaluate(ctx);
    expect(result).toBeNull();
  });

  it('skips when outputMint is missing from parsedArgs', async () => {
    const ctx = makeTxCtx({
      parsedArgs: {
        variant: 'route',
        inputMint: SOL,
        outAmount: '100000000',
        slippageBps: 100,
      },
    });
    const result = await sandwichRule.evaluate(ctx);
    expect(result).toBeNull();
  });

  it('skips when outAmount is missing from parsedArgs', async () => {
    const ctx = makeTxCtx({
      parsedArgs: {
        variant: 'route',
        inputMint: SOL,
        outputMint: USDC,
        slippageBps: 100,
      },
    });
    const result = await sandwichRule.evaluate(ctx);
    expect(result).toBeNull();
  });

  it('skips when outAmount is zero (no quote to compare)', async () => {
    const ctx = makeTxCtx({
      parsedArgs: {
        variant: 'route',
        inputMint: SOL,
        outputMint: USDC,
        outAmount: '0',
        slippageBps: 100,
      },
      tokenDeltas: [makeTokenDelta(USDC, '50000000')],
    });
    const result = await sandwichRule.evaluate(ctx);
    expect(result).toBeNull();
  });

  it('skips when no positive tokenDelta matches outputMint', async () => {
    // wrap-and-close wSOL: ATA closed mid-tx, no balance record. We
    // intentionally skip rather than guess via solDelta — keeps the rule
    // signal-noise ratio tight for Phase 1.
    const ctx = makeTxCtx({
      tokenDeltas: [makeTokenDelta(SOL, '-1000000000')],
    });
    const result = await sandwichRule.evaluate(ctx);
    expect(result).toBeNull();
  });

  it('uses per-agent threshold override when set (suppresses fire)', async () => {
    // 3% slippage, agent threshold 5% → null (agent override wins over default 2%)
    const ctx = makeTxCtx({
      tokenDeltas: [makeTokenDelta(USDC, '97000000')],
      agentThreshold: 5,
    });
    const result = await sandwichRule.evaluate(ctx);
    expect(result).toBeNull();
  });

  it('uses per-agent threshold override when set (allows fire)', async () => {
    // 1.5% slippage, agent threshold 1% → fires (default 2% would suppress)
    const ctx = makeTxCtx({
      tokenDeltas: [makeTokenDelta(USDC, '98500000')],
      agentThreshold: 1,
    });
    const result = await sandwichRule.evaluate(ctx);
    expect(result).not.toBeNull();
    expect(result?.payload).toMatchObject({ thresholdPct: 1 });
  });

  it('includes signature in dedupeKey', async () => {
    const ctx = makeTxCtx({
      tokenDeltas: [makeTokenDelta(USDC, '90000000')],
    });
    const result = await sandwichRule.evaluate(ctx);
    expect(result?.dedupeKey).toBe('sandwich:sandwich-sig-001');
  });

  it('treats negative agent threshold as misconfigured and skips', async () => {
    const ctx = makeTxCtx({
      tokenDeltas: [makeTokenDelta(USDC, '50000000')],
      agentThreshold: -1,
    });
    const result = await sandwichRule.evaluate(ctx);
    expect(result).toBeNull();
  });

  it('omits neighbourConfirmed flag absence — flag is always present (false when fetcher off)', async () => {
    // Phase 1 fallback path: no fetchSlotNeighbours injected → flag set to false.
    const ctx = makeTxCtx({ tokenDeltas: [makeTokenDelta(USDC, '90000000')] });
    const result = await sandwichRule.evaluate(ctx);
    expect(result?.payload).toMatchObject({ neighbourConfirmed: false });
    // No neighbour fields should be present when no fetcher ran.
    expect(result?.payload).not.toHaveProperty('neighbourSignature');
    expect(result?.payload).not.toHaveProperty('neighbourFeeLamports');
  });
});

describe('slippage_sandwich rule (Phase 2 — neighbour augmentation)', () => {
  it('escalates warning → critical when same-slot Jupiter neighbour paid higher fee', async () => {
    // 3% slippage = warning under default 2% threshold, but a confirmed
    // front-runner exists in the same slot.
    const fetcher = vi.fn<NeighbourFetcher>(async () => [
      makeNeighbour({ signature: 'frontrunner-001', feeLamports: 50000 }),
    ]);

    const ctx = makeTxCtx({
      tokenDeltas: [makeTokenDelta(USDC, '97000000')],
      fetchSlotNeighbours: fetcher,
    });
    const result = await sandwichRule.evaluate(ctx);

    expect(result?.severity).toBe('critical');
    expect(result?.payload).toMatchObject({
      neighbourConfirmed: true,
      neighbourSignature: 'frontrunner-001',
      neighbourFeeLamports: 50000,
    });
    expect(fetcher).toHaveBeenCalledWith(300_000_000);
  });

  it('keeps severity = warning when no neighbour beats the victim fee', async () => {
    const fetcher = vi.fn<NeighbourFetcher>(async () => [
      // Same fee — not a front-runner (could be the victim's own re-broadcast).
      makeNeighbour({ feeLamports: 5000 }),
      // Lower fee — definitely not a front-runner.
      makeNeighbour({ feeLamports: 3000 }),
    ]);

    const ctx = makeTxCtx({
      tokenDeltas: [makeTokenDelta(USDC, '97000000')],
      fetchSlotNeighbours: fetcher,
    });
    const result = await sandwichRule.evaluate(ctx);

    expect(result?.severity).toBe('warning');
    expect(result?.payload).toMatchObject({ neighbourConfirmed: false });
  });

  it('ignores neighbours that are not Jupiter swaps', async () => {
    const fetcher = vi.fn<NeighbourFetcher>(async () => [
      // High fee but a non-Jupiter program — unrelated mempool noise.
      makeNeighbour({
        feeLamports: 50000,
        programIds: ['11111111111111111111111111111111'],
      }),
    ]);

    const ctx = makeTxCtx({
      tokenDeltas: [makeTokenDelta(USDC, '97000000')],
      fetchSlotNeighbours: fetcher,
    });
    const result = await sandwichRule.evaluate(ctx);

    expect(result?.severity).toBe('warning');
    expect(result?.payload).toMatchObject({ neighbourConfirmed: false });
  });

  it('ignores failed neighbour transactions', async () => {
    const fetcher = vi.fn<NeighbourFetcher>(async () => [
      // High-fee Jupiter swap but it failed — can't have moved the pool.
      makeNeighbour({ feeLamports: 50000, success: false }),
    ]);

    const ctx = makeTxCtx({
      tokenDeltas: [makeTokenDelta(USDC, '97000000')],
      fetchSlotNeighbours: fetcher,
    });
    const result = await sandwichRule.evaluate(ctx);

    expect(result?.severity).toBe('warning');
    expect(result?.payload).toMatchObject({ neighbourConfirmed: false });
  });

  it('ignores a neighbour matching the victim signature (self-match defence)', async () => {
    const fetcher = vi.fn<NeighbourFetcher>(async () => [
      // The fetcher accidentally includes the victim itself with a
      // higher fee — should never escalate self.
      makeNeighbour({ signature: 'sandwich-sig-001', feeLamports: 99999 }),
    ]);

    const ctx = makeTxCtx({
      tokenDeltas: [makeTokenDelta(USDC, '97000000')],
      fetchSlotNeighbours: fetcher,
    });
    const result = await sandwichRule.evaluate(ctx);

    expect(result?.severity).toBe('warning');
    expect(result?.payload).toMatchObject({ neighbourConfirmed: false });
  });

  it('keeps severity = critical when slippage already crossed 5× threshold (cannot escalate further)', async () => {
    const fetcher = vi.fn<NeighbourFetcher>(async () => [makeNeighbour({ feeLamports: 99999 })]);

    const ctx = makeTxCtx({
      // 15% slippage = 7.5× threshold → critical pre-lookup
      tokenDeltas: [makeTokenDelta(USDC, '85000000')],
      fetchSlotNeighbours: fetcher,
    });
    const result = await sandwichRule.evaluate(ctx);

    expect(result?.severity).toBe('critical');
    expect(result?.payload).toMatchObject({ neighbourConfirmed: true });
  });

  it('degrades to Phase 1 behaviour when fetcher rejects (defensive)', async () => {
    const fetcher = vi.fn<NeighbourFetcher>(async () => {
      throw new Error('RPC timeout');
    });

    const ctx = makeTxCtx({
      tokenDeltas: [makeTokenDelta(USDC, '97000000')],
      fetchSlotNeighbours: fetcher,
    });
    const result = await sandwichRule.evaluate(ctx);

    // Rule must still fire on the evidence — RPC outages should not
    // silently kill the alert pipeline.
    expect(result?.severity).toBe('warning');
    expect(result?.payload).toMatchObject({ neighbourConfirmed: false });
  });

  it('does not query neighbours when evidence threshold is not met (avoid wasted RPC)', async () => {
    // 1% slippage < 2% threshold → null without ever calling fetcher.
    const fetcher = vi.fn<NeighbourFetcher>(async () => []);

    const ctx = makeTxCtx({
      tokenDeltas: [makeTokenDelta(USDC, '99000000')],
      fetchSlotNeighbours: fetcher,
    });
    const result = await sandwichRule.evaluate(ctx);

    expect(result).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });
});
