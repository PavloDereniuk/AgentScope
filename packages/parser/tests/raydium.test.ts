/**
 * TDD tests for the Raydium AMM v4 + CLMM parsers (A.4).
 *
 * AMM v4: code 9 (SwapBaseIn) and 11 (SwapBaseOut), 17 accounts,
 *   instruction bytes: [code][amountIn u64][minAmountOut u64].
 *
 * CLMM: Anchor swap_v2 discriminator 2b04ed0b1ac91e62,
 *   args: [amount u64][otherAmountThreshold u64][sqrtPriceLimit u128][isBaseInput bool].
 */

import { describe, expect, it } from 'vitest';
import { parseTransaction } from '../src/index';
import { loadFixtureAsParseInput } from './helpers/load-fixture';

const RAYDIUM_AMM_V4 = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8';
const RAYDIUM_CLMM = 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK';

// ─── AMM v4 ───────────────────────────────────────────────────────────────

interface AmmFixture {
  fixture: string;
  hasSwap: boolean;
}

const AMM_FIXTURES: AmmFixture[] = [
  { fixture: 'raydium-amm-1', hasSwap: true },
  { fixture: 'raydium-amm-2', hasSwap: true },
  { fixture: 'raydium-amm-3', hasSwap: true },
  // raydium-amm-4 is a WithdrawPnl (code 17) — not a swap
  { fixture: 'raydium-amm-4', hasSwap: false },
  { fixture: 'raydium-amm-5', hasSwap: true },
];

describe('raydium amm v4 parser — fixture coverage', () => {
  for (const { fixture, hasSwap } of AMM_FIXTURES) {
    it(`${fixture} → raydium program recognized`, () => {
      const input = loadFixtureAsParseInput(fixture);
      const parsed = parseTransaction(input);

      const raydiumIxs = parsed.instructions.filter((ix) => ix.programId === RAYDIUM_AMM_V4);
      expect(raydiumIxs.length, 'expected at least one Raydium AMM v4 instruction').toBeGreaterThan(
        0,
      );

      if (!hasSwap) return;

      const swapIx = raydiumIxs.find((ix) => ix.name === 'raydium.swap');
      expect(swapIx, `${fixture}: expected raydium.swap instruction`).toBeDefined();
    });
  }
});

describe('raydium amm v4 parser — swap args', () => {
  it('raydium-amm-1: swap args contain inputMint, outputMint, amountIn, minAmountOut, poolId', () => {
    const input = loadFixtureAsParseInput('raydium-amm-1');
    const parsed = parseTransaction(input);

    const swapIx = parsed.instructions.find(
      (ix) => ix.programId === RAYDIUM_AMM_V4 && ix.name === 'raydium.swap',
    );
    expect(swapIx, 'expected raydium.swap').toBeDefined();
    if (!swapIx) return;

    expect(swapIx.args).toMatchObject({
      inputMint: expect.any(String),
      outputMint: expect.any(String),
      amountIn: expect.any(String),
      minAmountOut: expect.any(String),
      poolId: expect.any(String),
    });

    const args = swapIx.args as {
      inputMint: string;
      outputMint: string;
      amountIn: string;
      minAmountOut: string;
    };
    expect(args.inputMint).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
    expect(args.outputMint).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
    expect(args.inputMint).not.toBe(args.outputMint);
    // amounts are u64 decimal strings
    expect(BigInt(args.amountIn)).toBeGreaterThan(0n);
    expect(BigInt(args.minAmountOut)).toBeGreaterThanOrEqual(0n);
  });

  it('raydium-amm-1: variant field present', () => {
    const input = loadFixtureAsParseInput('raydium-amm-1');
    const parsed = parseTransaction(input);
    const swapIx = parsed.instructions.find(
      (ix) => ix.programId === RAYDIUM_AMM_V4 && ix.name === 'raydium.swap',
    );
    expect(swapIx?.args).toMatchObject({ variant: expect.stringMatching(/^swap_base_(in|out)$/) });
  });
});

// ─── CLMM ─────────────────────────────────────────────────────────────────

describe('raydium clmm parser — fixture coverage', () => {
  const CLMM_FIXTURES = [
    'raydium-clmm-1',
    'raydium-clmm-2',
    'raydium-clmm-3',
    'raydium-clmm-4',
    'raydium-clmm-5',
  ];

  for (const fixture of CLMM_FIXTURES) {
    it(`${fixture} → raydium_clmm.swap recognized`, () => {
      const input = loadFixtureAsParseInput(fixture);
      const parsed = parseTransaction(input);

      const clmmIxs = parsed.instructions.filter((ix) => ix.programId === RAYDIUM_CLMM);
      expect(clmmIxs.length, 'expected at least one CLMM instruction').toBeGreaterThan(0);

      const swapIx = clmmIxs.find((ix) => ix.name === 'raydium_clmm.swap');
      expect(swapIx, `${fixture}: expected raydium_clmm.swap`).toBeDefined();
    });
  }
});

describe('raydium clmm parser — swap args', () => {
  it('raydium-clmm-1: args contain inputMint, outputMint, amountIn, otherAmountThreshold, poolId', () => {
    const input = loadFixtureAsParseInput('raydium-clmm-1');
    const parsed = parseTransaction(input);

    const swapIx = parsed.instructions.find(
      (ix) => ix.programId === RAYDIUM_CLMM && ix.name === 'raydium_clmm.swap',
    );
    expect(swapIx, 'expected raydium_clmm.swap').toBeDefined();
    if (!swapIx) return;

    expect(swapIx.args).toMatchObject({
      inputMint: expect.any(String),
      outputMint: expect.any(String),
      amountIn: expect.any(String),
      otherAmountThreshold: expect.any(String),
      poolId: expect.any(String),
    });

    const args = swapIx.args as {
      inputMint: string;
      outputMint: string;
      amountIn: string;
      otherAmountThreshold: string;
    };
    expect(args.inputMint).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
    expect(args.outputMint).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
    expect(args.inputMint).not.toBe(args.outputMint);
    expect(BigInt(args.amountIn)).toBeGreaterThan(0n);
  });

  it('raydium-clmm-1: variant is swap_v2, isBaseInput is boolean', () => {
    const input = loadFixtureAsParseInput('raydium-clmm-1');
    const parsed = parseTransaction(input);
    const swapIx = parsed.instructions.find(
      (ix) => ix.programId === RAYDIUM_CLMM && ix.name === 'raydium_clmm.swap',
    );
    expect(swapIx?.args).toMatchObject({
      variant: 'swap_v2',
      isBaseInput: expect.any(Boolean),
    });
  });
});
