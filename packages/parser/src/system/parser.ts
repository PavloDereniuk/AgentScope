/**
 * System Program instruction parser.
 *
 * The Solana System Program shows up in nearly every transaction —
 * fee payment, account creation, plain SOL transfers between wallets.
 * Without this parser those instructions surface as the bare
 * "System" friendly name, which leaves the dashboard showing "System"
 * for what is actually a SOL transfer or a new account allocation.
 *
 * We decode the small fixed-layout variants that carry meaningful
 * user-intent (Transfer, CreateAccount, Allocate) and surface the
 * rest as `system.unknown`. Variants whose args are variable-length
 * (CreateAccountWithSeed, TransferWithSeed) get a name but no decoded
 * args — the discriminator is enough to label them in the timeline.
 *
 * Layout reference: solana-program-library/sdk system_instruction.rs
 *   https://docs.rs/solana-sdk/latest/solana_sdk/system_instruction
 */

import type { ParsedArgs, SolanaPubkey } from '@agentscope/shared';
import { readU32LE, readU64LE } from '../binary';
import { registerParser } from '../dispatcher';
import type { ProgramParser } from '../types';

const SYSTEM_PROGRAM_ID = '11111111111111111111111111111111' as SolanaPubkey;

export const systemParser: ProgramParser = {
  programId: SYSTEM_PROGRAM_ID,
  namespace: 'system',

  decode(rawIxData, accountKeys, accountIndexes) {
    const disc = readU32LE(rawIxData, 0);
    if (disc === null) return null;

    const accountAt = (i: number): SolanaPubkey | null => {
      const idx = accountIndexes[i];
      if (idx === undefined) return null;
      return accountKeys[idx] ?? null;
    };

    switch (disc) {
      case 0: {
        // CreateAccount: u32 disc + u64 lamports + u64 space + 32-byte owner
        const lamports = readU64LE(rawIxData, 4);
        const space = readU64LE(rawIxData, 12);
        if (lamports === null || space === null) return null;
        return {
          name: 'create_account',
          args: {
            from: accountAt(0) ?? '',
            newAccount: accountAt(1) ?? '',
            lamports,
            space,
          } as ParsedArgs,
        };
      }
      case 2: {
        // Transfer: u32 disc + u64 lamports
        const lamports = readU64LE(rawIxData, 4);
        if (lamports === null) return null;
        return {
          name: 'transfer',
          args: {
            from: accountAt(0) ?? '',
            to: accountAt(1) ?? '',
            lamports,
          } as ParsedArgs,
        };
      }
      case 3:
        // CreateAccountWithSeed — variable-length seed string makes
        // safe decoding non-trivial; the name alone is enough for the UI.
        return { name: 'create_account_with_seed', args: {} as ParsedArgs };
      case 8: {
        // Allocate: u32 disc + u64 space
        const space = readU64LE(rawIxData, 4);
        if (space === null) return null;
        return {
          name: 'allocate',
          args: { account: accountAt(0) ?? '', space } as ParsedArgs,
        };
      }
      case 11:
        // TransferWithSeed — variable-length seed; label only.
        return { name: 'transfer_with_seed', args: {} as ParsedArgs };
      default:
        // Nonce ops, AssignWithSeed, etc. — fall through to system.unknown.
        return null;
    }
  },
};

// Self-register on import. Tests that need an empty registry can call
// _clearParserRegistry() in beforeEach and re-import.
registerParser(systemParser);
