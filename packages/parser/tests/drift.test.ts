/**
 * TDD tests for the Drift v2 perpetuals parser (A.6).
 *
 * Instructions: place_perp_order, place_orders, place_and_take_perp_order,
 * cancel_order, cancel_orders, deposit, withdraw.
 *
 * Discriminators + OrderParams layout verified against the official Drift IDL
 * (on-chain v2.150.0 + github.com/drift-labs/protocol-v2 v2.162.0). Fixtures are
 * constructed to that IDL layout: Drift's 2026 mainnet order flow is ~100% Swift
 * signed-message orders (keeper-submitted), so classic outer place/cancel calls
 * are absent from every pagination-reachable window (>6000 tx scanned, 0 hits).
 * The program state PDA and program id in these fixtures are the real on-chain
 * values; see scripts/fetch-drift-fixtures.ts for the (best-effort) live capture
 * path and packages/parser/src/drift/idl.json for the layout provenance.
 */

import { describe, expect, it } from 'vitest';
import { parseTransaction } from '../src/index';
import { loadFixtureAsParseInput } from './helpers/load-fixture';

const DRIFT_PROGRAM = 'dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH';
const AUTHORITY = 'GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB';
const USER = 'cGfHiC6Kgg3FpFZvgwGcswsCRtp4aBP2fzuXRQPizuN';

describe('drift parser — place_perp_order', () => {
  it('drift-place-perp-order-1: Limit Long perp market 0, size + price + accounts', () => {
    const parsed = parseTransaction(loadFixtureAsParseInput('drift-place-perp-order-1'));
    const ix = parsed.instructions.find((i) => i.name === 'drift.place_perp_order');
    expect(ix, 'expected drift.place_perp_order').toBeDefined();
    expect(ix?.args).toMatchObject({
      orderType: 'limit',
      marketType: 'perp',
      direction: 'long',
      marketIndex: 0,
      baseAssetAmount: '1000000000',
      price: '150500000',
      reduceOnly: false,
      userAccount: USER,
      authority: AUTHORITY,
    });
  });

  it('drift-place-perp-order-2: Market Short perp market 1, reduceOnly, price 0', () => {
    const parsed = parseTransaction(loadFixtureAsParseInput('drift-place-perp-order-2'));
    const ix = parsed.instructions.find((i) => i.name === 'drift.place_perp_order');
    expect(ix?.args).toMatchObject({
      orderType: 'market',
      marketType: 'perp',
      direction: 'short',
      marketIndex: 1,
      baseAssetAmount: '500000000',
      price: '0',
      reduceOnly: true,
    });
  });
});

describe('drift parser — place_and_take_perp_order', () => {
  it('drift-place-and-take-perp-order-1: authority resolved at index 3 (userStats at 2)', () => {
    const parsed = parseTransaction(loadFixtureAsParseInput('drift-place-and-take-perp-order-1'));
    const ix = parsed.instructions.find((i) => i.name === 'drift.place_and_take_perp_order');
    expect(ix, 'expected drift.place_and_take_perp_order').toBeDefined();
    expect(ix?.args).toMatchObject({
      orderType: 'market',
      marketType: 'perp',
      direction: 'long',
      marketIndex: 2,
      baseAssetAmount: '2000000000',
      userAccount: USER,
      authority: AUTHORITY,
    });
  });
});

describe('drift parser — place_orders', () => {
  it('drift-place-orders-1: batch of 2, first order summarized', () => {
    const parsed = parseTransaction(loadFixtureAsParseInput('drift-place-orders-1'));
    const ix = parsed.instructions.find((i) => i.name === 'drift.place_orders');
    expect(ix, 'expected drift.place_orders').toBeDefined();
    expect(ix?.args).toMatchObject({
      orderCount: 2,
      orderType: 'limit',
      marketType: 'perp',
      direction: 'long',
      marketIndex: 0,
      baseAssetAmount: '3000000000',
      price: '100000000',
    });
  });
});

describe('drift parser — cancel_order', () => {
  it('drift-cancel-order-1: orderId = 42', () => {
    const parsed = parseTransaction(loadFixtureAsParseInput('drift-cancel-order-1'));
    const ix = parsed.instructions.find((i) => i.name === 'drift.cancel_order');
    expect(ix, 'expected drift.cancel_order').toBeDefined();
    expect(ix?.args).toMatchObject({ orderId: 42, userAccount: USER, authority: AUTHORITY });
  });

  it('drift-cancel-order-2: orderId None → omitted (non-id-targeted cancel)', () => {
    const parsed = parseTransaction(loadFixtureAsParseInput('drift-cancel-order-2'));
    const ix = parsed.instructions.find((i) => i.name === 'drift.cancel_order');
    expect(ix, 'expected drift.cancel_order').toBeDefined();
    expect(ix?.args).not.toHaveProperty('orderId');
    expect(ix?.args).toMatchObject({ userAccount: USER, authority: AUTHORITY });
  });
});

describe('drift parser — cancel_orders', () => {
  it('drift-cancel-orders-1: marketType perp + marketIndex 0, direction None omitted', () => {
    const parsed = parseTransaction(loadFixtureAsParseInput('drift-cancel-orders-1'));
    const ix = parsed.instructions.find((i) => i.name === 'drift.cancel_orders');
    expect(ix, 'expected drift.cancel_orders').toBeDefined();
    expect(ix?.args).toMatchObject({ marketType: 'perp', marketIndex: 0 });
    expect(ix?.args).not.toHaveProperty('direction');
  });
});

describe('drift parser — deposit / withdraw', () => {
  it('drift-deposit-1: spot market 0, amount 100 USDC, authority at index 3', () => {
    const parsed = parseTransaction(loadFixtureAsParseInput('drift-deposit-1'));
    const ix = parsed.instructions.find((i) => i.name === 'drift.deposit');
    expect(ix, 'expected drift.deposit').toBeDefined();
    expect(ix?.args).toMatchObject({
      spotMarketIndex: 0,
      amount: '100000000',
      reduceOnly: false,
      userAccount: USER,
      authority: AUTHORITY,
    });
  });

  it('drift-withdraw-1: spot market 0, amount 50 USDC', () => {
    const parsed = parseTransaction(loadFixtureAsParseInput('drift-withdraw-1'));
    const ix = parsed.instructions.find((i) => i.name === 'drift.withdraw');
    expect(ix, 'expected drift.withdraw').toBeDefined();
    expect(ix?.args).toMatchObject({
      spotMarketIndex: 0,
      amount: '50000000',
      authority: AUTHORITY,
    });
  });
});

describe('drift parser — dispatch + program labelling', () => {
  it.each([
    'drift-place-perp-order-1',
    'drift-place-and-take-perp-order-1',
    'drift-cancel-order-1',
    'drift-deposit-1',
  ])('%s: instruction owned by the Drift program id', (fixture) => {
    const parsed = parseTransaction(loadFixtureAsParseInput(fixture));
    const ix = parsed.instructions.find((i) => i.programId === DRIFT_PROGRAM);
    expect(ix, `${fixture}: expected a Drift instruction`).toBeDefined();
    expect(ix?.name.startsWith('drift.')).toBe(true);
  });
});
