/**
 * TDD targets for the Kamino Lend parser (tasks 2.8 + 2.10).
 *
 * Each fixture from 2.4 was scanned in 2.9 to identify which lending
 * operations it contains. The parser landing in 2.10 must produce a
 * `kamino.<op>` instruction name for each known operation, where op
 * is one of: deposit, borrow, repay, withdraw, flash_borrow,
 * flash_repay. Refresh ops (refreshReserve / refreshObligation) are
 * utility wrappers that we map to `kamino.refresh_reserve` /
 * `kamino.refresh_obligation` but don't strictly assert.
 */

import { describe, expect, it } from 'vitest';
import { parseTransaction } from '../src/index';
import { loadFixtureAsParseInput } from './helpers/load-fixture';

const KAMINO_LEND = 'KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD';

interface FixtureExpectation {
  fixture: string;
  /** Lending op names (without `kamino.` prefix) we expect to find. */
  expectedOps: readonly string[];
}

const FIXTURES: FixtureExpectation[] = [
  { fixture: 'kamino-1', expectedOps: ['deposit'] },
  {
    fixture: 'kamino-2',
    expectedOps: ['flash_borrow', 'repay', 'withdraw', 'flash_repay'],
  },
  { fixture: 'kamino-3', expectedOps: ['deposit'] },
  { fixture: 'kamino-4', expectedOps: ['borrow'] },
  {
    fixture: 'kamino-5',
    expectedOps: ['deposit', 'borrow', 'flash_borrow', 'flash_repay'],
  },
];

describe('kamino lend parser — fixture coverage', () => {
  for (const { fixture, expectedOps } of FIXTURES) {
    it(`${fixture} → contains ${expectedOps.join(', ')}`, () => {
      const input = loadFixtureAsParseInput(fixture);
      const parsed = parseTransaction(input);

      const kaminoIxs = parsed.instructions.filter((ix) => ix.programId === KAMINO_LEND);
      expect(kaminoIxs.length, 'expected at least one Kamino instruction').toBeGreaterThan(0);

      const recognizedNames = kaminoIxs.map((ix) => ix.name).filter((n) => !n.endsWith('.unknown'));
      expect(recognizedNames.length, 'expected at least one recognized Kamino op').toBeGreaterThan(
        0,
      );

      for (const op of expectedOps) {
        const expectedName = `kamino.${op}`;
        expect(
          recognizedNames,
          `${fixture} should contain ${expectedName} (got: ${recognizedNames.join(', ')})`,
        ).toContain(expectedName);
      }
    });
  }
});

describe('kamino lend parser — instruction args', () => {
  it('deposit instructions carry liquidityAmount', () => {
    const input = loadFixtureAsParseInput('kamino-1');
    const parsed = parseTransaction(input);
    const deposit = parsed.instructions.find((ix) => ix.name === 'kamino.deposit');
    expect(deposit, 'expected kamino.deposit in fixture-1').toBeDefined();
    if (!deposit) return;

    expect(deposit.args).toMatchObject({
      liquidityAmount: expect.any(String),
    });
  });

  it('borrow instructions carry liquidityAmount', () => {
    const input = loadFixtureAsParseInput('kamino-4');
    const parsed = parseTransaction(input);
    const borrow = parsed.instructions.find((ix) => ix.name === 'kamino.borrow');
    expect(borrow, 'expected kamino.borrow in fixture-4').toBeDefined();
    if (!borrow) return;

    expect(borrow.args).toMatchObject({
      liquidityAmount: expect.any(String),
    });
  });
});
