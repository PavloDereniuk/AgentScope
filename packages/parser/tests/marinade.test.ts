/**
 * TDD tests for the Marinade Finance liquid-staking parser (A.7).
 *
 * deposit — disc f223c68952e1f2b6, 11 accounts, args@8: lamports(u64).
 * liquid_unstake — disc 1e1e77f0bfe30c10, 10 accounts, args@8: msol_amount(u64).
 * order_unstake — disc 61a7906b75be8024, 8 accounts, args@8: msol_amount(u64).
 * claim — disc 3ec6d6c1d59f6cd2, 6 accounts, no numeric args.
 *
 * Fixtures: marinade-deposit-{1,2}, marinade-liquid-unstake-{1,2},
 * marinade-order-unstake-1, marinade-claim-1 — all real mainnet tx.
 */

import { describe, expect, it } from 'vitest';
import { parseTransaction } from '../src/index';
import { loadFixtureAsParseInput } from './helpers/load-fixture';

const MARINADE_STATE = '8szGkuLTAux9XMgZ2vtY39jVSowEcpBfFfD8hXSEqdGC';
const RESERVE_PDA = 'Du3Ysj1wKbxPKkuPPnvzQLQh8oMSVifs3jGZjJWXFmHN';

describe('marinade parser — deposit', () => {
  it('marinade-deposit-1: recognized with amountLamports=5306000 and stateAddress', () => {
    const input = loadFixtureAsParseInput('marinade-deposit-1');
    const parsed = parseTransaction(input);

    const depositIx = parsed.instructions.find((ix) => ix.name === 'marinade.deposit');
    expect(depositIx, 'expected marinade.deposit').toBeDefined();
    expect(depositIx?.args).toMatchObject({
      amountLamports: '5306000',
      stateAddress: MARINADE_STATE,
    });
  });

  it('marinade-deposit-2: recognized with amountLamports=7515000', () => {
    const input = loadFixtureAsParseInput('marinade-deposit-2');
    const parsed = parseTransaction(input);

    const depositIx = parsed.instructions.find((ix) => ix.name === 'marinade.deposit');
    expect(depositIx, 'expected marinade.deposit').toBeDefined();
    expect(depositIx?.args).toMatchObject({
      amountLamports: '7515000',
      stateAddress: MARINADE_STATE,
    });
  });
});

describe('marinade parser — liquid_unstake', () => {
  it('marinade-liquid-unstake-1: recognized with msolAmount=3811720 and stateAddress', () => {
    const input = loadFixtureAsParseInput('marinade-liquid-unstake-1');
    const parsed = parseTransaction(input);

    const unstakeIx = parsed.instructions.find((ix) => ix.name === 'marinade.liquid_unstake');
    expect(unstakeIx, 'expected marinade.liquid_unstake').toBeDefined();
    expect(unstakeIx?.args).toMatchObject({
      msolAmount: '3811720',
      stateAddress: MARINADE_STATE,
    });
  });

  it('marinade-liquid-unstake-2: recognized with msolAmount=873730', () => {
    const input = loadFixtureAsParseInput('marinade-liquid-unstake-2');
    const parsed = parseTransaction(input);

    const unstakeIx = parsed.instructions.find((ix) => ix.name === 'marinade.liquid_unstake');
    expect(unstakeIx, 'expected marinade.liquid_unstake').toBeDefined();
    expect(unstakeIx?.args).toMatchObject({
      msolAmount: '873730',
      stateAddress: MARINADE_STATE,
    });
  });
});

describe('marinade parser — order_unstake', () => {
  it('marinade-order-unstake-1: recognized with msolAmount=718593781 and stateAddress', () => {
    const input = loadFixtureAsParseInput('marinade-order-unstake-1');
    const parsed = parseTransaction(input);

    const orderIx = parsed.instructions.find((ix) => ix.name === 'marinade.order_unstake');
    expect(orderIx, 'expected marinade.order_unstake').toBeDefined();
    expect(orderIx?.args).toMatchObject({
      msolAmount: '718593781',
      stateAddress: MARINADE_STATE,
    });
  });
});

describe('marinade parser — claim', () => {
  it('marinade-claim-1: recognized with stateAddress, reservePda, ticketAccount (no numeric args)', () => {
    const input = loadFixtureAsParseInput('marinade-claim-1');
    const parsed = parseTransaction(input);

    const claimIx = parsed.instructions.find((ix) => ix.name === 'marinade.claim');
    expect(claimIx, 'expected marinade.claim').toBeDefined();
    expect(claimIx?.args).toMatchObject({
      stateAddress: MARINADE_STATE,
      reservePda: RESERVE_PDA,
      ticketAccount: expect.any(String),
    });
    expect(claimIx?.args).not.toHaveProperty('msolAmount');
    expect(claimIx?.args).not.toHaveProperty('amountLamports');
  });
});

describe('marinade parser — all fixtures share the verified program state address', () => {
  it.each([
    'marinade-deposit-1',
    'marinade-deposit-2',
    'marinade-liquid-unstake-1',
    'marinade-liquid-unstake-2',
    'marinade-order-unstake-1',
    'marinade-claim-1',
  ])('%s: stateAddress = MARINADE_STATE', (fixture) => {
    const input = loadFixtureAsParseInput(fixture);
    const parsed = parseTransaction(input);
    const marinadeIx = parsed.instructions.find(
      (ix) => ix.programId === 'MarBmsSgKXdrN1egZf5sqe1TMai9K1rChYNDJgjq7aD',
    );
    expect(marinadeIx, `${fixture}: expected a Marinade instruction`).toBeDefined();
    expect(marinadeIx?.args).toMatchObject({ stateAddress: MARINADE_STATE });
  });
});
