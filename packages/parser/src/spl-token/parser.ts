/**
 * SPL Token instruction parser (A.10).
 *
 * Until this parser existed, every SPL Token instruction surfaced as the bare
 * friendly name "Token" — which meant AgentScope could see that *something*
 * touched the token program but never what. That blind spot is exactly where
 * agent wallets die: an `Approve` hands a delegate the right to move a token
 * balance at any later time, from a transaction that itself moves nothing and
 * therefore trips no balance-based rule. The `token_approval_anomaly` detector
 * rule reads the args decoded here.
 *
 * Scope: the fixed-layout core instructions that carry user intent about
 * *movement or delegation of funds* — Transfer, TransferChecked, Approve,
 * ApproveChecked, Revoke. Mints, burns, account lifecycle and the Token-2022
 * extension space (discriminators ≥ 43, each with its own nested sub-layout)
 * fall through to `spl_token.unknown`; they are labelling work, not security
 * signal, and a half-decoded extension is worse than an honest "unknown".
 *
 * Token-2022 shares byte-identical layouts for all five, so both programs are
 * registered against one decoder under a single `spl_token` namespace. Rules
 * then match one instruction name; anything that needs to tell the two programs
 * apart reads the program id, which the dispatcher keeps per instruction.
 *
 * Layout reference: solana-program-library/token/program/src/instruction.rs
 *   (TokenInstruction enum — the discriminator is the first byte)
 */

import type { ParsedArgs, SolanaPubkey } from '@agentscope/shared';
import { readU64LE } from '../binary';
import { registerParser } from '../dispatcher';
import type { ParseContext, ProgramParser } from '../types';

const TOKEN_PROGRAM_ID = 'TokenkegQfZFAhUJMRNbSL2vM5qTgaK5TxwQnEKL7aP' as SolanaPubkey;
const TOKEN_2022_PROGRAM_ID = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb' as SolanaPubkey;

const NAMESPACE = 'spl_token';

/** TokenInstruction discriminators we decode. */
const IX_TRANSFER = 3;
const IX_APPROVE = 4;
const IX_REVOKE = 5;
const IX_TRANSFER_CHECKED = 12;
const IX_APPROVE_CHECKED = 13;

function decodeTokenInstruction(
  rawIxData: Uint8Array,
  accountKeys: readonly SolanaPubkey[],
  accountIndexes: readonly number[],
  context: ParseContext,
): { name: string; args: ParsedArgs } | null {
  const disc = rawIxData[0];
  if (disc === undefined) return null;

  const accountAt = (i: number): SolanaPubkey | null => {
    const idx = accountIndexes[i];
    if (idx === undefined) return null;
    return accountKeys[idx] ?? null;
  };

  /**
   * The unchecked variants take a token account but not its mint. `meta`'s
   * token balances know which mint flowed through that account, so we recover
   * it — an approval without a mint tells the owner far less. Absent from meta
   * (accounts untouched by any balance change) the key is left out entirely
   * rather than filled with an empty string a consumer could mistake for a real
   * pubkey.
   */
  const mintOf = (tokenAccount: SolanaPubkey | null): { mint?: SolanaPubkey } => {
    if (!tokenAccount) return {};
    const mint = context.tokenAccountMints.get(tokenAccount);
    return mint ? { mint } : {};
  };

  switch (disc) {
    case IX_TRANSFER: {
      // Transfer: u8 disc + u64 amount; accounts [source, destination, authority]
      const amount = readU64LE(rawIxData, 1);
      const source = accountAt(0);
      const destination = accountAt(1);
      const authority = accountAt(2);
      if (amount === null || !source || !destination || !authority) return null;
      return {
        name: 'transfer',
        args: { source, destination, authority, amount, ...mintOf(source) } as ParsedArgs,
      };
    }
    case IX_APPROVE: {
      // Approve: u8 disc + u64 amount; accounts [source, delegate, owner]
      const amount = readU64LE(rawIxData, 1);
      const source = accountAt(0);
      const delegate = accountAt(1);
      const owner = accountAt(2);
      // A malformed account list leaves nothing to attribute the approval to.
      // Reporting a delegate-less approval would be worse than none.
      if (amount === null || !source || !delegate || !owner) return null;
      return {
        name: 'approve',
        args: { source, delegate, owner, amount, ...mintOf(source) } as ParsedArgs,
      };
    }
    case IX_REVOKE: {
      // Revoke: u8 disc only; accounts [source, owner]
      const source = accountAt(0);
      const owner = accountAt(1);
      if (!source || !owner) return null;
      return { name: 'revoke', args: { source, owner, ...mintOf(source) } as ParsedArgs };
    }
    case IX_TRANSFER_CHECKED: {
      // TransferChecked: u8 disc + u64 amount + u8 decimals;
      // accounts [source, mint, destination, authority]
      const amount = readU64LE(rawIxData, 1);
      const decimals = rawIxData[9];
      const source = accountAt(0);
      const mint = accountAt(1);
      const destination = accountAt(2);
      const authority = accountAt(3);
      if (amount === null || decimals === undefined) return null;
      if (!source || !mint || !destination || !authority) return null;
      return {
        name: 'transfer_checked',
        args: { source, mint, destination, authority, amount, decimals } as ParsedArgs,
      };
    }
    case IX_APPROVE_CHECKED: {
      // ApproveChecked: u8 disc + u64 amount + u8 decimals;
      // accounts [source, mint, delegate, owner]
      const amount = readU64LE(rawIxData, 1);
      const decimals = rawIxData[9];
      const source = accountAt(0);
      const mint = accountAt(1);
      const delegate = accountAt(2);
      const owner = accountAt(3);
      if (amount === null || decimals === undefined) return null;
      if (!source || !mint || !delegate || !owner) return null;
      return {
        name: 'approve_checked',
        args: { source, mint, delegate, owner, amount, decimals } as ParsedArgs,
      };
    }
    default:
      // Mints, burns, account lifecycle, multisig, and the whole Token-2022
      // extension range — labelled `spl_token.unknown` by the dispatcher.
      return null;
  }
}

export const splTokenParser: ProgramParser = {
  programId: TOKEN_PROGRAM_ID,
  namespace: NAMESPACE,
  decode: decodeTokenInstruction,
};

export const token2022Parser: ProgramParser = {
  programId: TOKEN_2022_PROGRAM_ID,
  namespace: NAMESPACE,
  decode: decodeTokenInstruction,
};

// Self-register on import, like every other parser module.
registerParser(splTokenParser);
registerParser(token2022Parser);
