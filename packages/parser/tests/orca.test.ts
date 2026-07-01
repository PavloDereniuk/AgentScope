/**
 * TDD tests for the Orca Whirlpools parser (A.5).
 *
 * swap (v1): disc f8c69e91e17587c8, 11 accounts.
 *   a_to_b flag + tokenAccountMints map → inputMint/outputMint.
 *
 * swap_v2: disc 2b04ed0b1ac91e62, 15+ accounts.
 *   Direct mints at accounts[5]/[6]. Amount args same layout as swap v1.
 *
 * Fixtures: orca-1 through orca-4 = swap v1; orca-4 = swap_v2.
 */

import { describe, expect, it } from 'vitest';
import { parseTransaction } from '../src/index';
import { loadFixtureAsParseInput } from './helpers/load-fixture';

const ORCA_WHIRLPOOL = 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc';

// ─── swap (v1) ────────────────────────────────────────────────────────────

describe('orca parser — swap v1 fixture coverage', () => {
  const SWAP_V1_FIXTURES = ['orca-1', 'orca-2', 'orca-3', 'orca-5'];

  for (const fixture of SWAP_V1_FIXTURES) {
    it(`${fixture} → orca.swap recognized`, () => {
      const input = loadFixtureAsParseInput(fixture);
      const parsed = parseTransaction(input);

      const orcaIxs = parsed.instructions.filter((ix) => ix.programId === ORCA_WHIRLPOOL);
      expect(orcaIxs.length, 'expected at least one Orca instruction').toBeGreaterThan(0);

      const swapIx = orcaIxs.find((ix) => ix.name === 'orca.swap');
      expect(swapIx, `${fixture}: expected orca.swap`).toBeDefined();
    });
  }
});

describe('orca parser — swap v1 args', () => {
  it('orca-1: args contain inputMint, outputMint, amountIn, poolId', () => {
    const input = loadFixtureAsParseInput('orca-1');
    const parsed = parseTransaction(input);

    const swapIx = parsed.instructions.find(
      (ix) => ix.programId === ORCA_WHIRLPOOL && ix.name === 'orca.swap',
    );
    expect(swapIx, 'expected orca.swap').toBeDefined();
    if (!swapIx) return;

    expect(swapIx.args).toMatchObject({
      inputMint: expect.any(String),
      outputMint: expect.any(String),
      otherAmountThreshold: expect.any(String),
      poolId: expect.any(String),
    });

    const args = swapIx.args as {
      inputMint: string;
      outputMint: string;
      otherAmountThreshold: string;
    };
    expect(args.inputMint).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
    expect(args.outputMint).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
    expect(args.inputMint).not.toBe(args.outputMint);
    expect(BigInt(args.otherAmountThreshold)).toBeGreaterThanOrEqual(0n);
  });

  it('orca-1: variant=swap, aToB=false, amountSpecifiedIsInput=true, amountIn>0', () => {
    const input = loadFixtureAsParseInput('orca-1');
    const parsed = parseTransaction(input);
    const swapIx = parsed.instructions.find(
      (ix) => ix.programId === ORCA_WHIRLPOOL && ix.name === 'orca.swap',
    );
    expect(swapIx?.args).toMatchObject({
      variant: 'swap',
      aToB: false,
      amountSpecifiedIsInput: true,
    });
    const args = swapIx?.args as { amountIn: string };
    expect(BigInt(args.amountIn)).toBeGreaterThan(0n);
  });

  it('orca-1: inputMint=USDC, outputMint=cbBTC (aToB=false → B→A direction)', () => {
    const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    const CB_BTC = 'cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij';
    const input = loadFixtureAsParseInput('orca-1');
    const parsed = parseTransaction(input);
    const swapIx = parsed.instructions.find(
      (ix) => ix.programId === ORCA_WHIRLPOOL && ix.name === 'orca.swap',
    );
    const args = swapIx?.args as { inputMint: string; outputMint: string };
    expect(args.inputMint).toBe(USDC);
    expect(args.outputMint).toBe(CB_BTC);
  });

  it('all swap v1 fixtures: inputMint ≠ outputMint, amounts parseable as BigInt', () => {
    for (const fixture of ['orca-1', 'orca-2', 'orca-3', 'orca-5']) {
      const input = loadFixtureAsParseInput(fixture);
      const parsed = parseTransaction(input);
      const swapIx = parsed.instructions.find(
        (ix) => ix.programId === ORCA_WHIRLPOOL && ix.name === 'orca.swap',
      );
      expect(swapIx, `${fixture}: expected orca.swap`).toBeDefined();
      if (!swapIx) continue;
      const args = swapIx.args as {
        inputMint: string;
        outputMint: string;
        amountIn: string;
        amountOut: string;
        otherAmountThreshold: string;
      };
      expect(args.inputMint).not.toBe(args.outputMint);
      expect(() => BigInt(args.amountIn)).not.toThrow();
      expect(() => BigInt(args.amountOut)).not.toThrow();
      expect(() => BigInt(args.otherAmountThreshold)).not.toThrow();
    }
  });
});

// ─── swap_v2 ──────────────────────────────────────────────────────────────

describe('orca parser — swap_v2 fixture coverage', () => {
  it('orca-4 → orca.swap recognized (swap_v2)', () => {
    const input = loadFixtureAsParseInput('orca-4');
    const parsed = parseTransaction(input);

    const orcaIxs = parsed.instructions.filter((ix) => ix.programId === ORCA_WHIRLPOOL);
    expect(orcaIxs.length, 'expected at least one Orca instruction').toBeGreaterThan(0);

    const swapIx = orcaIxs.find((ix) => ix.name === 'orca.swap');
    expect(swapIx, 'orca-4: expected orca.swap').toBeDefined();
  });
});

describe('orca parser — swap_v2 args', () => {
  it('orca-4: variant=swap_v2, inputMint=wSOL, outputMint=USDC (aToB=true)', () => {
    const WSOL = 'So11111111111111111111111111111111111111112';
    const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    const input = loadFixtureAsParseInput('orca-4');
    const parsed = parseTransaction(input);

    const swapIx = parsed.instructions.find(
      (ix) => ix.programId === ORCA_WHIRLPOOL && ix.name === 'orca.swap',
    );
    expect(swapIx, 'expected orca.swap').toBeDefined();
    if (!swapIx) return;

    expect(swapIx.args).toMatchObject({
      variant: 'swap_v2',
      aToB: true,
      amountSpecifiedIsInput: true,
    });

    const args = swapIx.args as {
      inputMint: string;
      outputMint: string;
      amountIn: string;
      poolId: string;
    };
    expect(args.inputMint).toBe(WSOL);
    expect(args.outputMint).toBe(USDC);
    expect(BigInt(args.amountIn)).toBeGreaterThan(0n);
    expect(args.poolId).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
  });

  it('orca-4: inputMint ≠ outputMint, all amounts parseable', () => {
    const input = loadFixtureAsParseInput('orca-4');
    const parsed = parseTransaction(input);
    const swapIx = parsed.instructions.find(
      (ix) => ix.programId === ORCA_WHIRLPOOL && ix.name === 'orca.swap',
    );
    if (!swapIx) return;
    const args = swapIx.args as {
      inputMint: string;
      outputMint: string;
      amountIn: string;
      amountOut: string;
      otherAmountThreshold: string;
    };
    expect(args.inputMint).not.toBe(args.outputMint);
    expect(() => BigInt(args.amountIn)).not.toThrow();
    expect(() => BigInt(args.amountOut)).not.toThrow();
    expect(() => BigInt(args.otherAmountThreshold)).not.toThrow();
  });
});
