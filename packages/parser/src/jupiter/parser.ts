/**
 * Jupiter v6 instruction parser.
 *
 * Decodes the various swap variants the aggregator emits — `route`,
 * `shared_accounts_route`, their `_v2` siblings, the exact-out
 * counterparts — into a uniform
 * `{ inputMint, outputMint, inAmount, outAmount, slippageBps }` shape
 * that the slippage detector rule (task 5.4) consumes.
 *
 * We bypass `BorshInstructionCoder` entirely because v6 instructions
 * carry a variable-length `route_plan` Vec that the auto-decoder
 * can't span without a runtime IDL parser for nested defined types.
 * Instead, we use the IDL only for:
 *   1. discriminator → instruction-name lookup
 *   2. account-name → position lookup (so source/destination_mint
 *      are read by name, not numeric index — variants differ)
 * and we read the three fixed numeric fields (in/out_amount,
 * quoted_in/out_amount, slippage_bps) at their well-known byte
 * offsets, which differ between v1 (fields at END of args, after
 * the route_plan vec) and v2 (fields at START, route_plan moved to
 * the end).
 */

import type { ParsedArgs, SolanaPubkey } from '@agentscope/shared';
import { registerParser } from '../dispatcher';
import type { ParseContext, ProgramParser } from '../types';
import idlJson from './idl.json' with { type: 'json' };

interface IdlAccount {
  name: string;
}
interface IdlInstruction {
  name: string;
  discriminator?: number[];
  accounts: IdlAccount[];
}
interface JupiterIdl {
  address?: string;
  instructions: IdlInstruction[];
}

const idl = idlJson as JupiterIdl;
const JUPITER_V6_PROGRAM_ID = (idl.address ??
  'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4') as SolanaPubkey;

/**
 * Layout descriptors for every swap variant we know how to parse.
 *
 * `endOffset` means the fixed fields live at the END of the args
 *   (route_plan precedes them — v1 family). Read backwards.
 * `startOffset` means the fixed fields live at the START of the args
 *   right after the discriminator (and an optional 1-byte `id` for
 *   shared_accounts_* variants — v2 family). Read forwards.
 * `exactOut` flips the semantics: in_amount/out_amount swap roles
 *   so the parsed `inAmount` always means "what the user pays" and
 *   `outAmount` always means "what the user receives".
 */
interface VariantLayout {
  startOffset?: number;
  endOffset?: 'tail19' | 'tail20';
  exactOut: boolean;
}

const VARIANT_LAYOUTS: Record<string, VariantLayout> = {
  // v1 family — route_plan first, fixed fields tail
  route: { endOffset: 'tail19', exactOut: false },
  route_with_token_ledger: { endOffset: 'tail19', exactOut: false },
  shared_accounts_route: { endOffset: 'tail19', exactOut: false },
  shared_accounts_route_with_token_ledger: { endOffset: 'tail19', exactOut: false },
  exact_out_route: { endOffset: 'tail19', exactOut: true },
  shared_accounts_exact_out_route: { endOffset: 'tail19', exactOut: true },

  // v2 family — fixed fields head (after 8-byte disc, plus 1-byte id
  // for shared_*), then route_plan at the end. The head block is 22
  // bytes: u64 in_amount + u64 quoted_out_amount + u16 slippage_bps +
  // u16 platform_fee_bps + u16 positive_slippage_bps.
  route_v2: { startOffset: 8, exactOut: false },
  shared_accounts_route_v2: { startOffset: 9, exactOut: false }, // skip id byte
  exact_out_route_v2: { startOffset: 8, exactOut: true },
  shared_accounts_exact_out_route_v2: { startOffset: 9, exactOut: true },
};

const SWAP_INSTRUCTIONS = new Set(Object.keys(VARIANT_LAYOUTS));

// ─── IDL indexes built once at module load ───────────────────────────────

function toHex(bytes: Uint8Array | number[]): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += (bytes[i] ?? 0).toString(16).padStart(2, '0');
  return out;
}

const discriminatorIndex = new Map<string, IdlInstruction>();
for (const ix of idl.instructions) {
  if (ix.discriminator?.length === 8) {
    discriminatorIndex.set(toHex(ix.discriminator), ix);
  }
}

// ─── Byte reading ─────────────────────────────────────────────────────────

/**
 * Read u64 little-endian as a decimal string. Uses BigInt to keep
 * full precision (token amounts overflow JS number above 2^53).
 */
function readU64LE(data: Uint8Array, offset: number): string | null {
  if (offset + 8 > data.length) return null;
  let value = 0n;
  for (let i = 7; i >= 0; i--) {
    value = (value << 8n) | BigInt(data[offset + i] ?? 0);
  }
  return value.toString();
}

function readU16LE(data: Uint8Array, offset: number): number | null {
  if (offset + 2 > data.length) return null;
  return (data[offset] ?? 0) | ((data[offset + 1] ?? 0) << 8);
}

interface FixedFields {
  inAmount: string; // what user pays
  outAmount: string; // what user receives
  slippageBps: number;
}

/**
 * Read the three fixed fields the detector cares about. Layout
 * differs between v1 (fields at end) and v2 (fields at start).
 *
 * For exactOut variants the on-chain field names are flipped:
 *   - exact_out: out_amount = what user receives, quoted_in_amount = what user pays
 *   - regular:   in_amount  = what user pays,    quoted_out_amount = what user receives
 * Either way, we expose them as inAmount=user-pays / outAmount=user-receives.
 */
function readFixedFields(data: Uint8Array, layout: VariantLayout): FixedFields | null {
  let amountAOff: number;
  let amountBOff: number;
  let slippageOff: number;

  if (layout.startOffset !== undefined) {
    // v2: head layout — [discriminator | (id) | amountA | amountB | slippage | ...]
    amountAOff = layout.startOffset;
    amountBOff = layout.startOffset + 8;
    slippageOff = layout.startOffset + 16;
  } else {
    // v1: tail layout — [...vec... | amountA | amountB | slippage | platform_fee_bps]
    // Last 19 bytes = 8 + 8 + 2 + 1
    amountAOff = data.length - 19;
    amountBOff = data.length - 11;
    slippageOff = data.length - 3;
  }

  const a = readU64LE(data, amountAOff);
  const b = readU64LE(data, amountBOff);
  const slippage = readU16LE(data, slippageOff);
  if (a === null || b === null || slippage === null) return null;

  // Field A is in_amount or out_amount; field B is quoted_out_amount or quoted_in_amount.
  // For exactOut variants, swap their roles so inAmount/outAmount stay user-centric.
  if (layout.exactOut) {
    return { inAmount: b, outAmount: a, slippageBps: slippage };
  }
  return { inAmount: a, outAmount: b, slippageBps: slippage };
}

// ─── Account lookup ───────────────────────────────────────────────────────

function findAccountByName(
  ixDef: IdlInstruction,
  name: string,
  accountKeys: readonly SolanaPubkey[],
  accountIndexes: readonly number[],
): SolanaPubkey | null {
  const positionInIx = ixDef.accounts.findIndex((a) => a.name === name);
  if (positionInIx < 0) return null;
  const indexIntoKeys = accountIndexes[positionInIx];
  if (indexIntoKeys === undefined) return null;
  return accountKeys[indexIntoKeys] ?? null;
}

/**
 * Resolve input and output mints for any swap variant.
 *
 * Three strategies, in order:
 *   1. Direct mint accounts: `source_mint`/`destination_mint` (or
 *      `input_mint`/`output_mint`). Used by `shared_accounts_route`
 *      and friends.
 *   2. Token-account → mint map: variant accounts include only token
 *      accounts (e.g. `user_source_token_account`); we resolve them
 *      to mints through `context.tokenAccountMints`. Works when the
 *      token account had a non-zero balance.
 *   3. Owner mint-flow fallback: when an account has zero balance both
 *      pre and post (wrap-and-close wSOL accounts are common), it
 *      doesn't appear in token balances at all. Fall back to
 *      `ownerSpentMints` / `ownerGainedMints` and pick whichever
 *      mint was spent (input) and gained (output) by the signer.
 */
function findInputOutputMints(
  ixDef: IdlInstruction,
  accountKeys: readonly SolanaPubkey[],
  accountIndexes: readonly number[],
  context: ParseContext,
): { inputMint: SolanaPubkey; outputMint: SolanaPubkey } | null {
  // Strategy 1 — direct mint accounts
  let inputMint =
    findAccountByName(ixDef, 'source_mint', accountKeys, accountIndexes) ??
    findAccountByName(ixDef, 'input_mint', accountKeys, accountIndexes);
  let outputMint =
    findAccountByName(ixDef, 'destination_mint', accountKeys, accountIndexes) ??
    findAccountByName(ixDef, 'output_mint', accountKeys, accountIndexes);

  // Strategy 2 — token accounts → mint via tokenAccountMints
  if (!inputMint) {
    const tokenAcct =
      findAccountByName(ixDef, 'user_source_token_account', accountKeys, accountIndexes) ??
      findAccountByName(ixDef, 'source_token_account', accountKeys, accountIndexes);
    if (tokenAcct) inputMint = context.tokenAccountMints.get(tokenAcct) ?? null;
  }
  if (!outputMint) {
    const tokenAcct =
      findAccountByName(ixDef, 'user_destination_token_account', accountKeys, accountIndexes) ??
      findAccountByName(ixDef, 'destination_token_account', accountKeys, accountIndexes);
    if (tokenAcct) outputMint = context.tokenAccountMints.get(tokenAcct) ?? null;
  }

  // Strategy 3 — owner balance flow (covers wrap-and-close wSOL ATAs
  // that never show up in pre/post token balances).
  if (!inputMint && context.ownerSpentMints.length > 0) {
    // Pick the first spent mint that isn't already the destination.
    inputMint =
      context.ownerSpentMints.find((m) => m !== outputMint) ?? context.ownerSpentMints[0] ?? null;
  }
  if (!outputMint && context.ownerGainedMints.length > 0) {
    outputMint =
      context.ownerGainedMints.find((m) => m !== inputMint) ?? context.ownerGainedMints[0] ?? null;
  }

  if (!inputMint || !outputMint) return null;
  return { inputMint, outputMint };
}

// ─── Public parser ────────────────────────────────────────────────────────

export const jupiterParser: ProgramParser = {
  programId: JUPITER_V6_PROGRAM_ID,
  namespace: 'jupiter',

  decode(rawIxData, accountKeys, accountIndexes, context) {
    if (rawIxData.length < 8) return null;

    const disc = toHex(rawIxData.slice(0, 8));
    const ixDef = discriminatorIndex.get(disc);
    if (!ixDef) return null;

    const layout = VARIANT_LAYOUTS[ixDef.name];
    if (!layout || !SWAP_INSTRUCTIONS.has(ixDef.name)) {
      // Recognized but not a swap (claim, create_token_account, etc.)
      return { name: ixDef.name, args: { variant: ixDef.name } as ParsedArgs };
    }

    const fields = readFixedFields(rawIxData, layout);
    if (!fields) return null;

    const mints = findInputOutputMints(ixDef, accountKeys, accountIndexes, context);
    if (!mints) return null;

    return {
      name: 'swap',
      args: {
        variant: ixDef.name,
        inputMint: mints.inputMint,
        outputMint: mints.outputMint,
        inAmount: fields.inAmount,
        outAmount: fields.outAmount,
        slippageBps: fields.slippageBps,
      } satisfies ParsedArgs,
    };
  },
};

// Self-register on import. Tests that need an empty registry can call
// _clearParserRegistry() in beforeEach and re-import.
registerParser(jupiterParser);
