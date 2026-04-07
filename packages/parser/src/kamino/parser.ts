/**
 * Kamino Lend instruction parser.
 *
 * Decodes the lending operations the protocol exposes (deposit,
 * borrow, repay, withdraw, flash_borrow, flash_repay) plus the two
 * utility refresh ops that wrap every operation. Each top-level
 * instruction emits a `kamino.<short_op>` instruction name and
 * a normalized args object containing the amount and key accounts.
 *
 * Implementation notes:
 *
 *  - The Kamino IDL is OLD anchor format (pre-0.30): no explicit
 *    `discriminator` field on instructions. We compute discriminators
 *    at module load as `sha256("global:<name>")[..8]`. We try both the
 *    raw camelCase IDL name and the snake_case form, since different
 *    Anchor versions and IDL serializers disagree on which to use.
 *
 *  - Kamino instructions use Anchor "composite accounts" — the IDL
 *    nests groups like `depositAccounts` containing the real
 *    `lendingMarket`, `reserve`, etc. We flatten the tree once at
 *    load time so account-by-name lookup works the same as Jupiter.
 *
 *  - Args are simple fixed-layout structs (one or two u64s, never
 *    variable-length), so we read raw bytes by offset rather than
 *    pulling in BorshInstructionCoder.
 */

import { createHash } from 'node:crypto';
import type { ParsedArgs, SolanaPubkey } from '@agentscope/shared';
import { registerParser } from '../dispatcher';
import type { ProgramParser } from '../types';
import idlJson from './idl.json' with { type: 'json' };

const KAMINO_LEND_PROGRAM_ID = 'KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD' as SolanaPubkey;

// ─── IDL types we read ───────────────────────────────────────────────────

interface IdlAccountLeaf {
  name: string;
  accounts?: undefined;
}
interface IdlAccountGroup {
  name: string;
  accounts: IdlAccountNode[];
}
type IdlAccountNode = IdlAccountLeaf | IdlAccountGroup;

interface IdlInstruction {
  name: string;
  accounts: IdlAccountNode[];
  args: { name: string; type: unknown }[];
}

interface KaminoIdl {
  instructions: IdlInstruction[];
}

const idl = idlJson as KaminoIdl;

// ─── Discriminator computation ───────────────────────────────────────────

function toHex(bytes: Uint8Array | number[]): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += (bytes[i] ?? 0).toString(16).padStart(2, '0');
  return s;
}

function camelToSnake(name: string): string {
  return name.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`).replace(/^_/, '');
}

function anchorDiscriminator(preimage: string): string {
  const hash = createHash('sha256').update(`global:${preimage}`).digest();
  return toHex(hash.subarray(0, 8));
}

// ─── Account flattening ──────────────────────────────────────────────────

/**
 * Flatten a (possibly nested) account tree into a single list of
 * leaf names in wire-format order. Recursive composite accounts are
 * walked depth-first.
 */
function flattenAccounts(nodes: readonly IdlAccountNode[]): string[] {
  const out: string[] = [];
  for (const node of nodes) {
    if (node.accounts) {
      out.push(...flattenAccounts(node.accounts));
    } else {
      out.push(node.name);
    }
  }
  return out;
}

// ─── Built indexes (computed once) ───────────────────────────────────────

interface IndexedInstruction {
  name: string;
  flatAccounts: readonly string[];
}

const discriminatorIndex = new Map<string, IndexedInstruction>();

for (const ix of idl.instructions) {
  const flat = flattenAccounts(ix.accounts);
  const indexed: IndexedInstruction = { name: ix.name, flatAccounts: flat };
  discriminatorIndex.set(anchorDiscriminator(ix.name), indexed);
  discriminatorIndex.set(anchorDiscriminator(camelToSnake(ix.name)), indexed);
}

// ─── Operation aliasing ───────────────────────────────────────────────────

/**
 * Map the long IDL instruction names to short canonical operation
 * names that downstream code (detector rules, dashboard timeline)
 * cares about. Anything not in this map gets `kamino.<idl_name>`
 * verbatim — useful for debugging which Kamino call was made even
 * when we haven't classified it.
 */
const OP_ALIAS: Record<string, string> = {
  depositReserveLiquidityAndObligationCollateral: 'deposit',
  depositReserveLiquidityAndObligationCollateralV2: 'deposit',
  borrowObligationLiquidity: 'borrow',
  borrowObligationLiquidityV2: 'borrow',
  repayObligationLiquidity: 'repay',
  repayObligationLiquidityV2: 'repay',
  withdrawObligationCollateralAndRedeemReserveCollateral: 'withdraw',
  withdrawObligationCollateralAndRedeemReserveCollateralV2: 'withdraw',
  flashBorrowReserveLiquidity: 'flash_borrow',
  flashRepayReserveLiquidity: 'flash_repay',
  refreshReserve: 'refresh_reserve',
  refreshObligation: 'refresh_obligation',
};

/**
 * Args readers per operation. The structs are tiny — one or two
 * u64s — so we read by offset rather than pulling in a full Borsh
 * decoder. The first 8 bytes of `data` are always the discriminator.
 */
type ArgsReader = (data: Uint8Array) => ParsedArgs | null;

function readU64LE(data: Uint8Array, offset: number): string | null {
  if (offset + 8 > data.length) return null;
  let value = 0n;
  for (let i = 7; i >= 0; i--) {
    value = (value << 8n) | BigInt(data[offset + i] ?? 0);
  }
  return value.toString();
}

const liquidityAmountReader: ArgsReader = (data) => {
  const amount = readU64LE(data, 8);
  if (amount === null) return null;
  return { liquidityAmount: amount };
};

const collateralAmountReader: ArgsReader = (data) => {
  const amount = readU64LE(data, 8);
  if (amount === null) return null;
  return { collateralAmount: amount };
};

const flashRepayReader: ArgsReader = (data) => {
  const amount = readU64LE(data, 8);
  if (amount === null || data.length < 17) return null;
  return {
    liquidityAmount: amount,
    borrowInstructionIndex: data[16] ?? 0,
  };
};

const noArgsReader: ArgsReader = () => ({});

const ARG_READERS: Record<string, ArgsReader> = {
  depositReserveLiquidityAndObligationCollateral: liquidityAmountReader,
  depositReserveLiquidityAndObligationCollateralV2: liquidityAmountReader,
  borrowObligationLiquidity: liquidityAmountReader,
  borrowObligationLiquidityV2: liquidityAmountReader,
  repayObligationLiquidity: liquidityAmountReader,
  repayObligationLiquidityV2: liquidityAmountReader,
  withdrawObligationCollateralAndRedeemReserveCollateral: collateralAmountReader,
  withdrawObligationCollateralAndRedeemReserveCollateralV2: collateralAmountReader,
  flashBorrowReserveLiquidity: liquidityAmountReader,
  flashRepayReserveLiquidity: flashRepayReader,
  refreshReserve: noArgsReader,
  refreshObligation: noArgsReader,
};

// ─── Account name lookup ─────────────────────────────────────────────────

function findAccountByName(
  flatAccounts: readonly string[],
  name: string,
  accountKeys: readonly SolanaPubkey[],
  accountIndexes: readonly number[],
): SolanaPubkey | null {
  const positionInIx = flatAccounts.indexOf(name);
  if (positionInIx < 0) return null;
  const indexIntoKeys = accountIndexes[positionInIx];
  if (indexIntoKeys === undefined) return null;
  return accountKeys[indexIntoKeys] ?? null;
}

// ─── Public parser ────────────────────────────────────────────────────────

export const kaminoParser: ProgramParser = {
  programId: KAMINO_LEND_PROGRAM_ID,
  namespace: 'kamino',

  decode(rawIxData, accountKeys, accountIndexes) {
    if (rawIxData.length < 8) return null;

    const disc = toHex(rawIxData.slice(0, 8));
    const ixDef = discriminatorIndex.get(disc);
    if (!ixDef) return null;

    const opName = OP_ALIAS[ixDef.name] ?? ixDef.name;
    const argsReader = ARG_READERS[ixDef.name];

    if (!argsReader) {
      // Recognized instruction but we haven't written an args reader
      // for it (e.g., admin / init ops). Still return the name so
      // callers can see what kamino call happened.
      return { name: opName, args: { variant: ixDef.name } as ParsedArgs };
    }

    const args = argsReader(rawIxData);
    if (!args) return null;

    // Best-effort enrichment with key accounts. Refresh ops have
    // very different account layouts — we skip enrichment for them.
    const lendingMarket = findAccountByName(
      ixDef.flatAccounts,
      'lendingMarket',
      accountKeys,
      accountIndexes,
    );
    const reserve = findAccountByName(ixDef.flatAccounts, 'reserve', accountKeys, accountIndexes);

    return {
      name: opName,
      args: {
        ...args,
        variant: ixDef.name,
        ...(lendingMarket ? { lendingMarket } : {}),
        ...(reserve ? { reserve } : {}),
      } as ParsedArgs,
    };
  },
};

// Self-register on import.
registerParser(kaminoParser);
