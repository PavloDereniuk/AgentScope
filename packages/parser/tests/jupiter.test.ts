/**
 * TDD red phase for the Jupiter v6 parser (task 2.5).
 *
 * These tests load the 5 mainnet swap fixtures from task 2.3 and
 * assert that the dispatcher returns:
 *   - instruction name "jupiter.swap"
 *   - args containing inputMint, outputMint, inAmount, outAmount,
 *     slippageBps (the fields the slippage detector rule needs)
 *
 * They WILL FAIL until task 2.7 lands the actual jupiter parser
 * module that registers itself with the dispatcher. Failing tests
 * are committed deliberately so the next task has a clear target.
 */

import { describe, expect, it } from 'vitest';
// Importing src/index ensures the jupiter parser self-registers via
// its import side-effect. We don't clear the registry between tests
// here because the parser is supposed to be active for every assertion.
import { parseTransaction } from '../src/index';
import { loadFixtureAsParseInput } from './helpers/load-fixture';

const JUPITER_V6 = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';

const FIXTURES = [
  'jupiter-swap-1',
  'jupiter-swap-2',
  'jupiter-swap-3',
  'jupiter-swap-4',
  'jupiter-swap-5',
] as const;

describe('jupiter v6 parser', () => {
  for (const name of FIXTURES) {
    it(`${name} → identifies jupiter.swap with normalized args`, () => {
      const input = loadFixtureAsParseInput(name);
      const parsed = parseTransaction(input);

      // Find the Jupiter top-level instruction (could be at any index
      // in a multi-instruction tx — wallet → jupiter is common).
      const jupiterIx = parsed.instructions.find((ix) => ix.programId === JUPITER_V6);
      expect(jupiterIx, 'expected at least one Jupiter v6 instruction').toBeDefined();
      if (!jupiterIx) return;

      // Name must be "jupiter.swap" — not the fallback "jup6.unknown"
      expect(jupiterIx.name).toBe('jupiter.swap');

      // Args must include the five fields the slippage rule will read
      expect(jupiterIx.args).toMatchObject({
        inputMint: expect.any(String),
        outputMint: expect.any(String),
        inAmount: expect.any(String),
        outAmount: expect.any(String),
        slippageBps: expect.any(Number),
      });

      // Sanity: mints must be base58 pubkey strings (32-44 chars)
      const args = jupiterIx.args as {
        inputMint: string;
        outputMint: string;
      };
      expect(args.inputMint).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
      expect(args.outputMint).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
      expect(args.inputMint).not.toBe(args.outputMint);
    });
  }
});

describe('jupiter parser tx-level fields', () => {
  it('jupiter-swap-1 → slot, success, fee come through', () => {
    const input = loadFixtureAsParseInput('jupiter-swap-1');
    const parsed = parseTransaction(input);

    expect(parsed.slot).toBeGreaterThan(0);
    expect(parsed.success).toBe(true);
    expect(parsed.feeLamports).toBeGreaterThan(0);
    expect(parsed.signature).toBe(input.signature);
  });
});
