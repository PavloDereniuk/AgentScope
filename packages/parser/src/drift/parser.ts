/**
 * Drift v2 perpetuals instruction parser (A.6).
 *
 * Anchor program: dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH (verified on-chain,
 * executable BPF program). State PDA 5zpq7DvB6UdFFvpmBPspGPNfUGoBRRCE2HHg5u3gxcsN
 * (findProgramAddress(['drift_state'], program)) confirmed owned by the program.
 *
 * Discriminators: sha256("global:<snake_case_name>")[..8]. Verified against the
 * official Drift IDL from two authoritative sources — the on-chain Anchor IDL
 * account (v2.150.0) and github.com/drift-labs/protocol-v2 (v2.162.0). The
 * OrderParams Borsh layout is taken verbatim from that IDL. See idl.json.
 *
 * Scope (owner decision, 2026-07-14): the classic order instructions an agent
 * emits via the standard @drift-labs/sdk — place/cancel orders + collateral
 * deposit/withdraw. NOT the keeper-side fill_* / Swift signed-message
 * instructions: those are submitted by Drift's keepers (not the observed agent),
 * and the dominant ones are not even present in the published IDL. Drift's 2026
 * mainnet order flow has migrated almost entirely to Swift, so classic outer
 * place/cancel calls could not be caught from any pagination-reachable window
 * (>6000 tx scanned, zero hits); the test fixtures are therefore constructed to
 * the official IDL layout rather than captured live. See A.6 notes in
 * POST-MVP-ROADMAP.md.
 *
 * Robustness note: every field the parser reads from OrderParams is fixed-size
 * and precedes the first Option field (maxTs), so decoding is correct regardless
 * of which trailing options a real order sets — no need to walk variable-length
 * option data.
 */

import type { ParsedArgs, SolanaPubkey } from '@agentscope/shared';
import { registerParser } from '../dispatcher';
import type { ProgramParser } from '../types';

const DRIFT_PROGRAM = 'dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH' as SolanaPubkey;

const DISC_PLACE_PERP_ORDER = '45a15dca787e4cb9';
const DISC_PLACE_ORDERS = '3c3f327b0cc53cbe';
const DISC_PLACE_AND_TAKE_PERP_ORDER = 'd53301bb6cdce6e0';
const DISC_CANCEL_ORDER = '5f81edf00831df84';
const DISC_CANCEL_ORDERS = 'eee15f9ee36708c2';
const DISC_DEPOSIT = 'f223c68952e1f2b6';
const DISC_WITHDRAW = 'b712469c946da122';

// Enum variant orderings are the Borsh discriminant values, taken from the IDL.
const ORDER_TYPE = ['market', 'limit', 'triggerMarket', 'triggerLimit', 'oracle'] as const;
const MARKET_TYPE = ['spot', 'perp'] as const;
const DIRECTION = ['long', 'short'] as const;

function toHex(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += (bytes[i] ?? 0).toString(16).padStart(2, '0');
  return s;
}

function readU16LE(data: Uint8Array, offset: number): number | null {
  if (offset + 2 > data.length) return null;
  return (data[offset] ?? 0) | ((data[offset + 1] ?? 0) << 8);
}

function readU32LE(data: Uint8Array, offset: number): number | null {
  if (offset + 4 > data.length) return null;
  return (
    ((data[offset] ?? 0) |
      ((data[offset + 1] ?? 0) << 8) |
      ((data[offset + 2] ?? 0) << 16) |
      ((data[offset + 3] ?? 0) << 24)) >>>
    0
  );
}

function readU64LE(data: Uint8Array, offset: number): string | null {
  if (offset + 8 > data.length) return null;
  let value = 0n;
  for (let i = 7; i >= 0; i--) {
    value = (value << 8n) | BigInt(data[offset + i] ?? 0);
  }
  return value.toString();
}

function enumLabel<T extends readonly string[]>(
  variants: T,
  data: Uint8Array,
  offset: number,
): T[number] | null {
  const idx = data[offset];
  if (idx === undefined) return null;
  return (variants[idx] as T[number] | undefined) ?? null;
}

function accountAt(
  accountKeys: readonly SolanaPubkey[],
  accountIndexes: readonly number[],
  position: number,
): SolanaPubkey | null {
  const idx = accountIndexes[position];
  if (idx === undefined) return null;
  return accountKeys[idx] ?? null;
}

/**
 * Decode the fixed-size prefix of an OrderParams struct starting at `offset`.
 * Returns the semantic fields common to every order (see idl.json layout).
 */
function decodeOrderParams(data: Uint8Array, offset: number): ParsedArgs | null {
  const orderType = enumLabel(ORDER_TYPE, data, offset + 0);
  const marketType = enumLabel(MARKET_TYPE, data, offset + 1);
  const direction = enumLabel(DIRECTION, data, offset + 2);
  const baseAssetAmount = readU64LE(data, offset + 4);
  const price = readU64LE(data, offset + 12);
  const marketIndex = readU16LE(data, offset + 20);
  if (baseAssetAmount === null || price === null || marketIndex === null) return null;
  const reduceOnly = (data[offset + 22] ?? 0) === 1;

  return {
    ...(orderType ? { orderType } : {}),
    ...(marketType ? { marketType } : {}),
    ...(direction ? { direction } : {}),
    marketIndex,
    baseAssetAmount,
    price,
    reduceOnly,
  } satisfies ParsedArgs;
}

export const driftParser: ProgramParser = {
  programId: DRIFT_PROGRAM,
  namespace: 'drift',

  decode(rawIxData, accountKeys, accountIndexes) {
    if (rawIxData.length < 8) return null;
    const disc = toHex(rawIxData.slice(0, 8));

    // Single-perp-order and batch placement share the [state, user, authority] map.
    if (disc === DISC_PLACE_PERP_ORDER) {
      if (accountIndexes.length < 3) return null;
      const order = decodeOrderParams(rawIxData, 8);
      if (!order) return null;
      const user = accountAt(accountKeys, accountIndexes, 1);
      const authority = accountAt(accountKeys, accountIndexes, 2);
      return {
        name: 'place_perp_order',
        args: {
          ...order,
          ...(user ? { userAccount: user } : {}),
          ...(authority ? { authority } : {}),
        } satisfies ParsedArgs,
      };
    }

    if (disc === DISC_PLACE_ORDERS) {
      if (accountIndexes.length < 3) return null;
      const orderCount = readU32LE(rawIxData, 8);
      if (orderCount === null) return null;
      // Summarize the first order (offset 12, after the u32 vec length).
      const first = orderCount > 0 ? decodeOrderParams(rawIxData, 12) : null;
      const user = accountAt(accountKeys, accountIndexes, 1);
      const authority = accountAt(accountKeys, accountIndexes, 2);
      return {
        name: 'place_orders',
        args: {
          orderCount,
          ...(first ?? {}),
          ...(user ? { userAccount: user } : {}),
          ...(authority ? { authority } : {}),
        } satisfies ParsedArgs,
      };
    }

    // place_and_take inserts userStats at index 2, pushing authority to index 3.
    if (disc === DISC_PLACE_AND_TAKE_PERP_ORDER) {
      if (accountIndexes.length < 4) return null;
      const order = decodeOrderParams(rawIxData, 8);
      if (!order) return null;
      const user = accountAt(accountKeys, accountIndexes, 1);
      const authority = accountAt(accountKeys, accountIndexes, 3);
      return {
        name: 'place_and_take_perp_order',
        args: {
          ...order,
          ...(user ? { userAccount: user } : {}),
          ...(authority ? { authority } : {}),
        } satisfies ParsedArgs,
      };
    }

    if (disc === DISC_CANCEL_ORDER) {
      if (accountIndexes.length < 3) return null;
      const hasOrderId = (rawIxData[8] ?? 0) === 1;
      const orderId = hasOrderId ? readU32LE(rawIxData, 9) : null;
      const user = accountAt(accountKeys, accountIndexes, 1);
      const authority = accountAt(accountKeys, accountIndexes, 2);
      return {
        name: 'cancel_order',
        args: {
          // orderId omitted when None — signals a non-id-targeted cancel.
          ...(orderId !== null ? { orderId } : {}),
          ...(user ? { userAccount: user } : {}),
          ...(authority ? { authority } : {}),
        } satisfies ParsedArgs,
      };
    }

    if (disc === DISC_CANCEL_ORDERS) {
      if (accountIndexes.length < 3) return null;
      let cursor = 8;
      let marketType: string | null = null;
      if ((rawIxData[cursor] ?? 0) === 1) {
        marketType = enumLabel(MARKET_TYPE, rawIxData, cursor + 1);
        cursor += 2;
      } else {
        cursor += 1;
      }
      let marketIndex: number | null = null;
      if ((rawIxData[cursor] ?? 0) === 1) {
        marketIndex = readU16LE(rawIxData, cursor + 1);
        cursor += 3;
      } else {
        cursor += 1;
      }
      let direction: string | null = null;
      if ((rawIxData[cursor] ?? 0) === 1) {
        direction = enumLabel(DIRECTION, rawIxData, cursor + 1);
      }
      const user = accountAt(accountKeys, accountIndexes, 1);
      const authority = accountAt(accountKeys, accountIndexes, 2);
      return {
        name: 'cancel_orders',
        args: {
          ...(marketType ? { marketType } : {}),
          ...(marketIndex !== null ? { marketIndex } : {}),
          ...(direction ? { direction } : {}),
          ...(user ? { userAccount: user } : {}),
          ...(authority ? { authority } : {}),
        } satisfies ParsedArgs,
      };
    }

    // Collateral movement: deposit/withdraw share the args layout; authority at idx 3.
    if (disc === DISC_DEPOSIT || disc === DISC_WITHDRAW) {
      if (accountIndexes.length < 4) return null;
      const marketIndex = readU16LE(rawIxData, 8);
      const amount = readU64LE(rawIxData, 10);
      if (marketIndex === null || amount === null) return null;
      const reduceOnly = (rawIxData[18] ?? 0) === 1;
      const user = accountAt(accountKeys, accountIndexes, 1);
      const authority = accountAt(accountKeys, accountIndexes, 3);
      return {
        name: disc === DISC_DEPOSIT ? 'deposit' : 'withdraw',
        args: {
          spotMarketIndex: marketIndex,
          amount,
          reduceOnly,
          ...(user ? { userAccount: user } : {}),
          ...(authority ? { authority } : {}),
        } satisfies ParsedArgs,
      };
    }

    return null;
  },
};

// Self-register on import
registerParser(driftParser);
