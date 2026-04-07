/**
 * Public types for @agentscope/parser.
 *
 * A parser takes a raw on-chain transaction (as returned by web3.js
 * `getTransaction`) plus the owning agent's wallet, and returns a
 * normalized `ParsedTx` that downstream consumers can store, query,
 * and feed into the detector without re-parsing IDL bytes themselves.
 */

import type {
  ISOTimestamp,
  ParsedArgs,
  SolanaPubkey,
  SolanaSignature,
  TokenDelta,
} from '@agentscope/shared';
import type { VersionedTransactionResponse } from '@solana/web3.js';

/**
 * One parsed top-level instruction. Inner CPI instructions are NOT
 * parsed in MVP — Jupiter routes through dozens of inner CPIs and we
 * only need the outer "swap" call to detect slippage / size.
 */
export interface ParsedInstruction {
  /** Position in the transaction's outer-instruction list. */
  index: number;
  /** Program that owns this instruction (Jupiter v6, Kamino Lend, etc.). */
  programId: SolanaPubkey;
  /**
   * Dot-namespaced instruction identifier, e.g. "jupiter.swap" or
   * "kamino.deposit". Stable across IDL versions; the second segment
   * matches the Anchor instruction name in snake_case.
   */
  name: string;
  /**
   * Decoded args from the program IDL. Schema is per-instruction:
   *   jupiter.swap → { inputMint, outputMint, inAmount, outAmount, slippageBps }
   *   kamino.deposit → { reserve, lendingMarket, liquidityAmount }
   *   etc.
   */
  args: ParsedArgs;
}

/**
 * Normalized representation of a single agent transaction, ready to
 * persist into `agent_transactions` and feed to the detector.
 */
export interface ParsedTx {
  signature: SolanaSignature;
  slot: number;
  blockTime: ISOTimestamp;
  /** Top-level instructions only — see ParsedInstruction note about CPIs. */
  instructions: readonly ParsedInstruction[];
  /**
   * Net SOL delta for the agent's wallet (signed, decimal string with
   * 9-digit precision). Computed from pre/post balances of the owning
   * pubkey, NOT from instruction args.
   */
  solDelta: string;
  /**
   * Net token deltas for the agent's wallet, one entry per (mint, owner)
   * pair. Computed from `meta.preTokenBalances` / `meta.postTokenBalances`
   * filtered to the owner.
   */
  tokenDeltas: readonly TokenDelta[];
  feeLamports: number;
  success: boolean;
  /** Raw program logs — kept for debugging and re-parse pipelines. */
  rawLogs: readonly string[];
}

/**
 * Input shape for `parseTransaction`. The parser owns no I/O — caller
 * fetches the raw transaction with `connection.getTransaction(sig,
 * { maxSupportedTransactionVersion: 0 })` and passes it in.
 */
export interface ParseInput {
  signature: SolanaSignature;
  slot: number;
  blockTime: ISOTimestamp;
  /** Wallet pubkey of the agent that owns this tx (for delta computation). */
  ownerPubkey: SolanaPubkey;
  /** Raw response from @solana/web3.js getTransaction. */
  transaction: VersionedTransactionResponse;
}

/**
 * Per-program parser entry. The registry in `index.ts` looks up the
 * matching ProgramParser by programId before decoding each instruction.
 */
export interface ProgramParser {
  /** Solana program ID this parser handles. */
  programId: SolanaPubkey;
  /** Friendly name shown in logs ("jupiter", "kamino"). */
  namespace: string;
  /**
   * Decode a single top-level instruction's args. Returns null if the
   * instruction discriminator doesn't match anything this parser knows
   * (in which case the dispatcher records `name = "unknown"`).
   */
  decode(
    rawIxData: Uint8Array,
    accountKeys: readonly SolanaPubkey[],
    accountIndexes: readonly number[],
  ): { name: string; args: ParsedArgs } | null;
}
