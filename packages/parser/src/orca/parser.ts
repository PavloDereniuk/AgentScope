/**
 * Orca Whirlpools instruction parser (A.5).
 *
 * Anchor program: whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc
 * Discriminators: sha256("global:<snake_case_name>")[..8]. Verified against
 * mainnet fixtures (2026-07) — see packages/parser/src/orca/idl.json.
 *
 * swap (v1) — disc f8c69e91e17587c8, 11 accounts:
 *   [0] tokenProgram  [1] tokenAuthority  [2] whirlpool
 *   [3] tokenOwnerAccountA  [4] tokenVaultA
 *   [5] tokenOwnerAccountB  [6] tokenVaultB
 *   [7..9] tickArrays  [10] oracle
 *   a_to_b=true → input=mintA, output=mintB; false → input=mintB, output=mintA
 *   Mints resolved via tokenAccountMints[tokenOwnerAccount{A,B}].
 *
 * swap_v2 — disc 2b04ed0b1ac91e62, 15+ accounts:
 *   [0] tokenProgramA  [1] tokenProgramB  [2] memoProgram  [3] tokenAuthority
 *   [4] whirlpool  [5] tokenMintA (direct)  [6] tokenMintB (direct)
 *   [7] tokenOwnerAccountA  [8] tokenVaultA
 *   [9] tokenOwnerAccountB  [10] tokenVaultB
 *   [11..13] tickArrays  [14] oracle  (optional remaining: transfer hooks)
 *   Same args + same direction semantics. Direct mints supersede account lookup.
 *
 * two_hop_swap — disc c360ed6c44a2dbe6:
 *   args@8: amount(u64) otherAmountThreshold(u64)
 *           amountSpecifiedIsInput(bool@24) aToBOne(bool@25) aToBTwo(bool@26)
 *   Mints from owner net flows (no direct mint accounts in v1).
 *
 * two_hop_swap_v2 — disc ba8fd11dfe02c275, same args, same fallback.
 */

import type { ParsedArgs, SolanaPubkey } from '@agentscope/shared';
import { registerParser } from '../dispatcher';
import type { ParseContext, ProgramParser } from '../types';

const ORCA_WHIRLPOOL = 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc' as SolanaPubkey;

const DISC_SWAP = 'f8c69e91e17587c8';
const DISC_SWAP_V2 = '2b04ed0b1ac91e62';
const DISC_TWO_HOP = 'c360ed6c44a2dbe6';
const DISC_TWO_HOP_V2 = 'ba8fd11dfe02c275';

// ─── Byte helpers ──────────────────────────────────────────────────────────

function readU64LE(data: Uint8Array, offset: number): string | null {
  if (offset + 8 > data.length) return null;
  let value = 0n;
  for (let i = 7; i >= 0; i--) {
    value = (value << 8n) | BigInt(data[offset + i] ?? 0);
  }
  return value.toString();
}

function toHex(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += (bytes[i] ?? 0).toString(16).padStart(2, '0');
  return s;
}

// ─── Mint resolution ───────────────────────────────────────────────────────

/**
 * Resolve input/output mints for a single-pool Orca swap.
 * Strategy 1: token-account pubkey → mint via balance map.
 * Strategy 2: owner net flow fallback (same pattern as Raydium).
 */
function resolveSwapMints(
  sourceTa: SolanaPubkey | null,
  destTa: SolanaPubkey | null,
  context: ParseContext,
): { inputMint: SolanaPubkey; outputMint: SolanaPubkey } | null {
  let inputMint: SolanaPubkey | null = sourceTa
    ? (context.tokenAccountMints.get(sourceTa) ?? null)
    : null;
  let outputMint: SolanaPubkey | null = destTa
    ? (context.tokenAccountMints.get(destTa) ?? null)
    : null;

  if (!inputMint && context.ownerSpentMints.length > 0) {
    inputMint =
      context.ownerSpentMints.find((m) => m !== outputMint) ?? context.ownerSpentMints[0] ?? null;
  }
  if (!outputMint && context.ownerGainedMints.length > 0) {
    outputMint =
      context.ownerGainedMints.find((m) => m !== inputMint) ?? context.ownerGainedMints[0] ?? null;
  }

  if (!inputMint || !outputMint || inputMint === outputMint) return null;
  return { inputMint, outputMint };
}

// ─── Parser ───────────────────────────────────────────────────────────────

export const orcaParser: ProgramParser = {
  programId: ORCA_WHIRLPOOL,
  namespace: 'orca',

  decode(rawIxData, accountKeys, accountIndexes, context) {
    if (rawIxData.length < 8) return null;

    const disc = toHex(rawIxData.slice(0, 8));

    // ── swap (v1) ─────────────────────────────────────────────────────────
    if (disc === DISC_SWAP) {
      if (rawIxData.length < 42 || accountIndexes.length < 11) return null;

      const amount = readU64LE(rawIxData, 8);
      const otherAmountThreshold = readU64LE(rawIxData, 16);
      if (amount === null || otherAmountThreshold === null) return null;

      const amountSpecifiedIsInput = (rawIxData[40] ?? 0) !== 0;
      const aToB = (rawIxData[41] ?? 0) !== 0;

      const poolId = (accountKeys[accountIndexes[2] ?? -1] ?? null) as SolanaPubkey | null;
      // aToB=true → user sends A[3], receives B[5]; false → user sends B[5], receives A[3]
      const sourceTa = (accountKeys[accountIndexes[aToB ? 3 : 5] ?? -1] ??
        null) as SolanaPubkey | null;
      const destTa = (accountKeys[accountIndexes[aToB ? 5 : 3] ?? -1] ??
        null) as SolanaPubkey | null;

      const mints = resolveSwapMints(sourceTa, destTa, context);
      if (!mints) return null;

      return {
        name: 'swap',
        args: {
          variant: 'swap',
          inputMint: mints.inputMint,
          outputMint: mints.outputMint,
          amountIn: amountSpecifiedIsInput ? amount : '0',
          amountOut: !amountSpecifiedIsInput ? amount : '0',
          otherAmountThreshold,
          amountSpecifiedIsInput,
          aToB,
          ...(poolId ? { poolId } : {}),
        } satisfies ParsedArgs,
      };
    }

    // ── swap_v2 ────────────────────────────────────────────────────────────
    if (disc === DISC_SWAP_V2) {
      if (rawIxData.length < 42 || accountIndexes.length < 15) return null;

      const amount = readU64LE(rawIxData, 8);
      const otherAmountThreshold = readU64LE(rawIxData, 16);
      if (amount === null || otherAmountThreshold === null) return null;

      const amountSpecifiedIsInput = (rawIxData[40] ?? 0) !== 0;
      const aToB = (rawIxData[41] ?? 0) !== 0;

      // Direct mints at acc[5]=tokenMintA, acc[6]=tokenMintB; pool at acc[4]
      const mintA = (accountKeys[accountIndexes[5] ?? -1] ?? null) as SolanaPubkey | null;
      const mintB = (accountKeys[accountIndexes[6] ?? -1] ?? null) as SolanaPubkey | null;
      const poolId = (accountKeys[accountIndexes[4] ?? -1] ?? null) as SolanaPubkey | null;

      if (!mintA || !mintB || mintA === mintB) return null;

      const inputMint = aToB ? mintA : mintB;
      const outputMint = aToB ? mintB : mintA;

      return {
        name: 'swap',
        args: {
          variant: 'swap_v2',
          inputMint,
          outputMint,
          amountIn: amountSpecifiedIsInput ? amount : '0',
          amountOut: !amountSpecifiedIsInput ? amount : '0',
          otherAmountThreshold,
          amountSpecifiedIsInput,
          aToB,
          ...(poolId ? { poolId } : {}),
        } satisfies ParsedArgs,
      };
    }

    // ── two_hop_swap ───────────────────────────────────────────────────────
    if (disc === DISC_TWO_HOP || disc === DISC_TWO_HOP_V2) {
      if (rawIxData.length < 27) return null;

      const amount = readU64LE(rawIxData, 8);
      const otherAmountThreshold = readU64LE(rawIxData, 16);
      if (amount === null || otherAmountThreshold === null) return null;

      const amountSpecifiedIsInput = (rawIxData[24] ?? 0) !== 0;
      const aToBOne = (rawIxData[25] ?? 0) !== 0;
      const aToBTwo = (rawIxData[26] ?? 0) !== 0;

      // Net user flow: inputMint = what user spent, outputMint = what user gained
      const inputMint = context.ownerSpentMints[0] ?? null;
      const outputMint = context.ownerGainedMints[0] ?? null;

      if (!inputMint || !outputMint || inputMint === outputMint) return null;

      const variant = disc === DISC_TWO_HOP ? 'two_hop_swap' : 'two_hop_swap_v2';

      return {
        name: 'two_hop_swap',
        args: {
          variant,
          inputMint,
          outputMint,
          amountIn: amountSpecifiedIsInput ? amount : '0',
          amountOut: !amountSpecifiedIsInput ? amount : '0',
          otherAmountThreshold,
          amountSpecifiedIsInput,
          aToBOne,
          aToBTwo,
        } satisfies ParsedArgs,
      };
    }

    return null;
  },
};

// Self-register on import
registerParser(orcaParser);
