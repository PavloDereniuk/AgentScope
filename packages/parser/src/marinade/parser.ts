/**
 * Marinade Finance liquid-staking instruction parser (A.7).
 *
 * Anchor program: MarBmsSgKXdrN1egZf5sqe1TMai9K1rChYNDJgjq7aD
 *
 * NOTE: an earlier roadmap draft listed `MarBmsSgKXdrN1egZf5sqe1TMThiYsCfVuvAJBbQNTQ`
 * for this program — that address does not exist on mainnet (getAccountInfo → null).
 * The address above is verified against docs.marinade.finance/developers/contract-addresses
 * and a live getAccountInfo call returning an executable BPF program. See design notes
 * in POST-MVP-ROADMAP.md A.7 for the correction.
 *
 * Discriminators: sha256("global:<snake_case_name>")[..8]. Verified against mainnet
 * fixtures (2026-07) — see packages/parser/src/marinade/idl.json.
 *
 * deposit — disc f223c68952e1f2b6, 11 accounts, args@8: lamports(u64).
 *   accounts[0] = state (verified against docs' Main State Account).
 *
 * liquid_unstake — disc 1e1e77f0bfe30c10, 10 accounts, args@8: msol_amount(u64).
 *   accounts[4] = treasuryMsolAccount, matches docs' Treasury mSOL Account exactly.
 *
 * order_unstake — disc 61a7906b75be8024, 8 accounts, args@8: msol_amount(u64).
 *   Creates a delayed-unstake ticket, redeemable later via claim().
 *
 * claim — disc 3ec6d6c1d59f6cd2, 6 accounts, NO numeric args (amount lives in the
 *   ticket account, not the instruction data). accounts[1] = reservePda, matches
 *   docs' Reserve SOL Account exactly.
 *
 * All four instructions move only SOL <-> mSOL — unlike swap parsers there is no
 * arbitrary input/output mint to resolve, so args stay flat (amount + state/ticket
 * addresses) rather than the swap-style {inputMint, outputMint} shape.
 */

import type { ParsedArgs, SolanaPubkey } from '@agentscope/shared';
import { registerParser } from '../dispatcher';
import type { ProgramParser } from '../types';

const MARINADE_FINANCE = 'MarBmsSgKXdrN1egZf5sqe1TMai9K1rChYNDJgjq7aD' as SolanaPubkey;

const DISC_DEPOSIT = 'f223c68952e1f2b6';
const DISC_LIQUID_UNSTAKE = '1e1e77f0bfe30c10';
const DISC_ORDER_UNSTAKE = '61a7906b75be8024';
const DISC_CLAIM = '3ec6d6c1d59f6cd2';

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

function accountAt(
  accountKeys: readonly SolanaPubkey[],
  accountIndexes: readonly number[],
  position: number,
): SolanaPubkey | null {
  const idx = accountIndexes[position];
  if (idx === undefined) return null;
  return accountKeys[idx] ?? null;
}

export const marinadeParser: ProgramParser = {
  programId: MARINADE_FINANCE,
  namespace: 'marinade',

  decode(rawIxData, accountKeys, accountIndexes) {
    if (rawIxData.length < 8) return null;

    const disc = toHex(rawIxData.slice(0, 8));
    const stateAddress = accountAt(accountKeys, accountIndexes, 0);

    if (disc === DISC_DEPOSIT) {
      if (accountIndexes.length < 11) return null;
      const amountLamports = readU64LE(rawIxData, 8);
      if (amountLamports === null) return null;

      return {
        name: 'deposit',
        args: {
          amountLamports,
          ...(stateAddress ? { stateAddress } : {}),
        } satisfies ParsedArgs,
      };
    }

    if (disc === DISC_LIQUID_UNSTAKE) {
      if (accountIndexes.length < 10) return null;
      const msolAmount = readU64LE(rawIxData, 8);
      if (msolAmount === null) return null;

      return {
        name: 'liquid_unstake',
        args: {
          msolAmount,
          ...(stateAddress ? { stateAddress } : {}),
        } satisfies ParsedArgs,
      };
    }

    if (disc === DISC_ORDER_UNSTAKE) {
      if (accountIndexes.length < 8) return null;
      const msolAmount = readU64LE(rawIxData, 8);
      if (msolAmount === null) return null;

      return {
        name: 'order_unstake',
        args: {
          msolAmount,
          ...(stateAddress ? { stateAddress } : {}),
        } satisfies ParsedArgs,
      };
    }

    if (disc === DISC_CLAIM) {
      if (accountIndexes.length < 6) return null;
      const reservePda = accountAt(accountKeys, accountIndexes, 1);
      const ticketAccount = accountAt(accountKeys, accountIndexes, 2);

      return {
        name: 'claim',
        args: {
          ...(stateAddress ? { stateAddress } : {}),
          ...(reservePda ? { reservePda } : {}),
          ...(ticketAccount ? { ticketAccount } : {}),
        } satisfies ParsedArgs,
      };
    }

    return null;
  },
};

// Self-register on import
registerParser(marinadeParser);
