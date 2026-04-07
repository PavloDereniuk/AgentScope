/**
 * Top-level dispatcher: takes a raw web3.js transaction response,
 * runs every outer instruction through the matching ProgramParser
 * (or marks it `unknown`), and computes net SOL / token deltas for
 * the owning agent.
 *
 * Per-program parsers (jupiter, kamino) register themselves into
 * `parserRegistry` from their own modules — see tasks 2.7 and 2.10.
 */

import type { ISOTimestamp, ParsedArgs, SolanaPubkey, TokenDelta } from '@agentscope/shared';
import type {
  CompiledInstruction,
  MessageCompiledInstruction,
  TokenBalance,
  VersionedTransactionResponse,
} from '@solana/web3.js';
import type { ParseInput, ParsedInstruction, ParsedTx, ProgramParser } from './types';

/**
 * Mutable registry of per-program parsers. Each parser module calls
 * `registerParser(parser)` at import time. Order doesn't matter — the
 * dispatcher looks up by programId.
 */
const parserRegistry = new Map<string, ProgramParser>();

export function registerParser(parser: ProgramParser): void {
  parserRegistry.set(parser.programId, parser);
}

/** Test helper: clear registry between unit tests. */
export function _clearParserRegistry(): void {
  parserRegistry.clear();
}

/** Test helper: list registered programIds. */
export function _registeredProgramIds(): string[] {
  return Array.from(parserRegistry.keys());
}

// ─── Helpers ──────────────────────────────────────────────────────────────

/**
 * Resolve all account keys for a transaction, including any addresses
 * loaded from address-table lookups. Order matters: static keys first,
 * then loaded writable, then loaded readonly — this is the canonical
 * indexing order Solana uses for instruction `accounts[]` indexes.
 */
function collectAccountKeys(tx: VersionedTransactionResponse): SolanaPubkey[] {
  const message = tx.transaction.message;
  // VersionedMessage has staticAccountKeys; legacy Message has accountKeys.
  const staticKeys =
    'staticAccountKeys' in message
      ? message.staticAccountKeys.map((k) => k.toBase58() as SolanaPubkey)
      : (message as { accountKeys: { toBase58(): string }[] }).accountKeys.map(
          (k) => k.toBase58() as SolanaPubkey,
        );

  const loadedWritable =
    tx.meta?.loadedAddresses?.writable?.map((k) => k.toBase58() as SolanaPubkey) ?? [];
  const loadedReadonly =
    tx.meta?.loadedAddresses?.readonly?.map((k) => k.toBase58() as SolanaPubkey) ?? [];

  return [...staticKeys, ...loadedWritable, ...loadedReadonly];
}

/**
 * Extract the outer instructions in a uniform shape regardless of
 * legacy vs versioned transactions. Both expose `programIdIndex`,
 * `accounts` (or `accountKeyIndexes`), and a `data` byte buffer.
 */
interface UniformInstruction {
  programIdIndex: number;
  accountIndexes: readonly number[];
  data: Uint8Array;
}

function extractInstructions(tx: VersionedTransactionResponse): UniformInstruction[] {
  const message = tx.transaction.message;

  if ('compiledInstructions' in message) {
    // VersionedMessage
    return (message.compiledInstructions as MessageCompiledInstruction[]).map((ix) => ({
      programIdIndex: ix.programIdIndex,
      accountIndexes: ix.accountKeyIndexes,
      data: ix.data,
    }));
  }

  // Legacy Message — instructions are CompiledInstructions with base58 data
  const legacy = (message as { instructions: CompiledInstruction[] }).instructions;
  return legacy.map((ix) => ({
    programIdIndex: ix.programIdIndex,
    accountIndexes: ix.accounts,
    // Legacy CompiledInstruction.data is a base58 string. For MVP we
    // accept the rare hit and decode lazily — most modern devnet tx are v0.
    data: typeof ix.data === 'string' ? Buffer.from(ix.data, 'base64') : ix.data,
  }));
}

/**
 * Compute the net SOL delta for a single owner pubkey by diffing the
 * post and pre lamport balances of that account. Returns a signed
 * decimal string with 9-digit precision (1 SOL = 1e9 lamports).
 */
function computeSolDelta(
  tx: VersionedTransactionResponse,
  ownerPubkey: SolanaPubkey,
  accountKeys: readonly SolanaPubkey[],
): string {
  const ownerIdx = accountKeys.indexOf(ownerPubkey);
  if (ownerIdx < 0 || !tx.meta) return '0';

  const pre = tx.meta.preBalances[ownerIdx];
  const post = tx.meta.postBalances[ownerIdx];
  if (pre === undefined || post === undefined) return '0';

  const deltaLamports = BigInt(post) - BigInt(pre);
  return formatLamports(deltaLamports);
}

/** Format signed lamport bigint as a 9-digit decimal SOL string. */
function formatLamports(lamports: bigint): string {
  const negative = lamports < 0n;
  const abs = negative ? -lamports : lamports;
  const whole = abs / 1_000_000_000n;
  const frac = abs % 1_000_000_000n;
  const fracStr = frac.toString().padStart(9, '0');
  return `${negative ? '-' : ''}${whole}.${fracStr}`;
}

/**
 * Compute net token deltas for the owner across all SPL token accounts
 * referenced in this transaction. Returns one entry per (mint) — if the
 * agent owns multiple token accounts for the same mint, they're summed.
 */
function computeTokenDeltas(
  tx: VersionedTransactionResponse,
  ownerPubkey: SolanaPubkey,
): TokenDelta[] {
  if (!tx.meta?.preTokenBalances || !tx.meta.postTokenBalances) return [];

  const byMint = new Map<string, { decimals: number; delta: bigint }>();

  function add(balances: readonly TokenBalance[], sign: 1n | -1n): void {
    for (const b of balances) {
      if (b.owner !== ownerPubkey) continue;
      const raw = b.uiTokenAmount.amount;
      const amount = BigInt(raw);
      const existing = byMint.get(b.mint);
      const decimals = b.uiTokenAmount.decimals;
      if (existing) {
        existing.delta += amount * sign;
      } else {
        byMint.set(b.mint, { decimals, delta: amount * sign });
      }
    }
  }

  add(tx.meta.postTokenBalances, 1n);
  add(tx.meta.preTokenBalances, -1n);

  const out: TokenDelta[] = [];
  for (const [mint, { decimals, delta }] of byMint) {
    if (delta === 0n) continue;
    out.push({
      mint: mint as SolanaPubkey,
      decimals,
      delta: delta.toString(),
    });
  }
  return out;
}

// ─── Public dispatcher ────────────────────────────────────────────────────

const UNKNOWN_NAME = 'unknown';

export function parseTransaction(input: ParseInput): ParsedTx {
  const accountKeys = collectAccountKeys(input.transaction);
  const rawInstructions = extractInstructions(input.transaction);

  const instructions: ParsedInstruction[] = rawInstructions.map((ix, index) => {
    const programId = accountKeys[ix.programIdIndex];
    if (!programId) {
      // Malformed — index out of range. Record as unknown rather than throw.
      return {
        index,
        programId: '' as SolanaPubkey,
        name: UNKNOWN_NAME,
        args: {} as ParsedArgs,
      };
    }

    const parser = parserRegistry.get(programId);
    if (!parser) {
      return {
        index,
        programId,
        name: `${truncatedNamespace(programId)}.${UNKNOWN_NAME}`,
        args: {} as ParsedArgs,
      };
    }

    const decoded = parser.decode(ix.data, accountKeys, ix.accountIndexes);
    if (!decoded) {
      return {
        index,
        programId,
        name: `${parser.namespace}.${UNKNOWN_NAME}`,
        args: {} as ParsedArgs,
      };
    }

    return {
      index,
      programId,
      name: `${parser.namespace}.${decoded.name}`,
      args: decoded.args,
    };
  });

  const solDelta = computeSolDelta(input.transaction, input.ownerPubkey, accountKeys);
  const tokenDeltas = computeTokenDeltas(input.transaction, input.ownerPubkey);

  return {
    signature: input.signature,
    slot: input.slot,
    blockTime: input.blockTime,
    instructions,
    solDelta,
    tokenDeltas,
    feeLamports: Number(input.transaction.meta?.fee ?? 0),
    success: input.transaction.meta?.err === null,
    rawLogs: input.transaction.meta?.logMessages ?? [],
  } as const satisfies ParsedTx & { blockTime: ISOTimestamp };
}

/** Fallback namespace for unregistered programs: first 4 chars of pubkey. */
function truncatedNamespace(programId: SolanaPubkey): string {
  return programId.slice(0, 4).toLowerCase();
}
