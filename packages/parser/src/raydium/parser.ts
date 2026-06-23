/**
 * Raydium AMM v4 + CLMM instruction parsers (A.4).
 *
 * AMM v4 (`675kPX9...`) is a non-Anchor program — no on-chain IDL exists.
 * Instruction layout is verified against mainnet fixtures (2026-06):
 *   byte 0          = instruction code (9 = SwapBaseIn, 11 = SwapBaseOut)
 *   bytes 1..9      = amount_in  (u64 LE)
 *   bytes 9..17     = min_amount_out (u64 LE)
 *   accounts[14]    = user_source_token_account
 *   accounts[15]    = user_destination_token_account
 *   accounts[1]     = amm (pool address)
 *
 * CLMM (`CAMMCzo5...`) is Anchor. swap_v2 discriminator = sha256("global:swap_v2")[..8].
 *   bytes 8..16     = amount (u64 LE)
 *   bytes 16..24    = other_amount_threshold (u64 LE)
 *   bytes 24..40    = sqrt_price_limit_x64 (u128 LE, unused for slippage calc)
 *   byte 40         = is_base_input (bool)
 *   accounts[11]    = input_vault_mint
 *   accounts[12]    = output_vault_mint
 *   accounts[3]     = pool_state (pool id)
 */

import type { ParsedArgs, SolanaPubkey } from '@agentscope/shared';
import { registerParser } from '../dispatcher';
import type { ParseContext, ProgramParser } from '../types';

const RAYDIUM_AMM_V4 = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8' as SolanaPubkey;
const RAYDIUM_CLMM = 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK' as SolanaPubkey;

// CLMM swap_v2 discriminator (sha256("global:swap_v2")[..8])
const CLMM_SWAP_V2_DISC = '2b04ed0b1ac91e62';
// CLMM swap (v1, older pools) discriminator (sha256("global:swap")[..8])
const CLMM_SWAP_V1_DISC = 'f8c69e91e17587c8';

// ─── Byte helpers ──────────────────────────────────────────────────────────

function readU64LE(data: Uint8Array, offset: number): string | null {
  if (offset + 8 > data.length) return null;
  let value = 0n;
  for (let i = 7; i >= 0; i--) {
    value = (value << 8n) | BigInt(data[offset + i] ?? 0);
  }
  return value.toString();
}

function toHex(bytes: Uint8Array | number[]): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += (bytes[i] ?? 0).toString(16).padStart(2, '0');
  return s;
}

// ─── Mint resolution ───────────────────────────────────────────────────────

/**
 * Try to resolve input and output mints for a swap instruction.
 * Strategy: direct account (if mint pubkey known), then token-account
 * map, then owner-flow fallback (same 3-step pattern as Jupiter).
 */
function resolveMints(
  directInputMint: SolanaPubkey | null,
  directOutputMint: SolanaPubkey | null,
  sourceTokenAccount: SolanaPubkey | null,
  destTokenAccount: SolanaPubkey | null,
  context: ParseContext,
): { inputMint: SolanaPubkey; outputMint: SolanaPubkey } | null {
  let inputMint = directInputMint;
  let outputMint = directOutputMint;

  // Strategy 2 — token account → mint via balance map
  if (!inputMint && sourceTokenAccount) {
    inputMint = context.tokenAccountMints.get(sourceTokenAccount) ?? null;
  }
  if (!outputMint && destTokenAccount) {
    outputMint = context.tokenAccountMints.get(destTokenAccount) ?? null;
  }

  // Strategy 3 — owner balance flows
  if (!inputMint && context.ownerSpentMints.length > 0) {
    inputMint =
      context.ownerSpentMints.find((m) => m !== outputMint) ?? context.ownerSpentMints[0] ?? null;
  }
  if (!outputMint && context.ownerGainedMints.length > 0) {
    outputMint =
      context.ownerGainedMints.find((m) => m !== inputMint) ?? context.ownerGainedMints[0] ?? null;
  }

  if (!inputMint || !outputMint) return null;
  if (inputMint === outputMint) return null;
  return { inputMint, outputMint };
}

// ─── AMM v4 Parser ────────────────────────────────────────────────────────

export const raydiumAmmParser: ProgramParser = {
  programId: RAYDIUM_AMM_V4,
  namespace: 'raydium',

  decode(rawIxData, accountKeys, accountIndexes, context) {
    if (rawIxData.length < 1) return null;

    const code = rawIxData[0];

    // Only handle swap instructions (9 = SwapBaseIn, 11 = SwapBaseOut)
    if (code !== 9 && code !== 11) return null;

    // Swap instructions have exactly 17 accounts
    if (accountIndexes.length !== 17) return null;

    // Read amounts (offset 1 = first arg, offset 9 = second arg)
    const firstAmount = readU64LE(rawIxData, 1);
    const secondAmount = readU64LE(rawIxData, 9);
    if (firstAmount === null || secondAmount === null) return null;

    // code 9 SwapBaseIn: firstAmount = amount_in, secondAmount = min_amount_out
    // code 11 SwapBaseOut: firstAmount = max_amount_in, secondAmount = amount_out
    const isBaseIn = code === 9;
    const amountIn = isBaseIn ? firstAmount : firstAmount; // max_in when base-out
    const minAmountOut = isBaseIn ? secondAmount : secondAmount; // exact out when base-out

    // accounts[1] = amm pool, [14] = source token account, [15] = dest token account
    const poolId = accountKeys[accountIndexes[1] ?? -1] ?? null;
    const sourceTa = (accountKeys[accountIndexes[14] ?? -1] ?? null) as SolanaPubkey | null;
    const destTa = (accountKeys[accountIndexes[15] ?? -1] ?? null) as SolanaPubkey | null;

    const mints = resolveMints(null, null, sourceTa, destTa, context);
    if (!mints) return null;

    return {
      name: 'swap',
      args: {
        variant: isBaseIn ? 'swap_base_in' : 'swap_base_out',
        inputMint: mints.inputMint,
        outputMint: mints.outputMint,
        amountIn,
        minAmountOut,
        ...(poolId ? { poolId } : {}),
      } satisfies ParsedArgs,
    };
  },
};

// ─── CLMM Parser ──────────────────────────────────────────────────────────

export const raydiumClmmParser: ProgramParser = {
  programId: RAYDIUM_CLMM,
  namespace: 'raydium_clmm',

  decode(rawIxData, accountKeys, accountIndexes, context) {
    if (rawIxData.length < 41) return null;

    const disc = toHex(rawIxData.slice(0, 8));
    const isV2 = disc === CLMM_SWAP_V2_DISC;
    const isV1 = disc === CLMM_SWAP_V1_DISC;
    if (!isV2 && !isV1) return null;

    const amount = readU64LE(rawIxData, 8);
    const otherAmountThreshold = readU64LE(rawIxData, 16);
    if (amount === null || otherAmountThreshold === null) return null;

    const isBaseInput = (rawIxData[40] ?? 0) !== 0;

    // For swap_v2: accounts[11] = input_vault_mint, accounts[12] = output_vault_mint
    // For swap (v1): accounts[9] = input_vault_mint, accounts[10] = output_vault_mint
    const mintInputIdx = isV2 ? 11 : 9;
    const mintOutputIdx = isV2 ? 12 : 10;
    const poolIdx = isV2 ? 3 : 2;

    const directInputMint = (accountKeys[accountIndexes[mintInputIdx] ?? -1] ??
      null) as SolanaPubkey | null;
    const directOutputMint = (accountKeys[accountIndexes[mintOutputIdx] ?? -1] ??
      null) as SolanaPubkey | null;

    // Source/dest token accounts at [4]/[5] (both versions)
    const sourceTa = (accountKeys[accountIndexes[4] ?? -1] ?? null) as SolanaPubkey | null;
    const destTa = (accountKeys[accountIndexes[5] ?? -1] ?? null) as SolanaPubkey | null;

    const mints = resolveMints(directInputMint, directOutputMint, sourceTa, destTa, context);
    if (!mints) return null;

    // is_base_input = true → amount is exactIn, otherAmountThreshold is minOut
    // is_base_input = false → amount is exactOut, otherAmountThreshold is maxIn
    const amountIn = isBaseInput ? amount : '0';
    const amountOut = !isBaseInput ? amount : '0';
    const poolId = (accountKeys[accountIndexes[poolIdx] ?? -1] ?? null) as SolanaPubkey | null;

    return {
      name: 'swap',
      args: {
        variant: isV2 ? 'swap_v2' : 'swap',
        inputMint: mints.inputMint,
        outputMint: mints.outputMint,
        amountIn,
        amountOut,
        otherAmountThreshold,
        isBaseInput,
        ...(poolId ? { poolId } : {}),
      } satisfies ParsedArgs,
    };
  },
};

// Self-register on import
registerParser(raydiumAmmParser);
registerParser(raydiumClmmParser);
