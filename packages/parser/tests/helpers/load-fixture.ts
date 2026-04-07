/**
 * Loader for the JSON fixtures captured in tasks 2.3 / 2.4.
 *
 * The fixtures hold the raw base64-encoded JSON-RPC response from
 * `getTransaction`. To feed them through the parser dispatcher we
 * need to reconstruct a `VersionedTransactionResponse` shape — that
 * means deserializing the base64 transaction bytes into a real
 * VersionedTransaction (so message.staticAccountKeys / compiled
 * instructions are typed PublicKeys / Uint8Arrays) and re-wrapping
 * the meta object with PublicKey instances for loadedAddresses.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ISOTimestamp, SolanaPubkey, SolanaSignature } from '@agentscope/shared';
import { PublicKey, VersionedTransaction } from '@solana/web3.js';
import type { VersionedTransactionResponse } from '@solana/web3.js';
import type { ParseInput } from '../../src/types';

const FIXTURES_DIR = join(import.meta.dirname, '..', 'fixtures');

interface RawFixture {
  signature: string;
  response: {
    slot: number;
    blockTime: number | null;
    version: 'legacy' | 0;
    transaction: [string, 'base64'];
    meta: {
      err: unknown;
      fee: number;
      preBalances: number[];
      postBalances: number[];
      preTokenBalances?: unknown[];
      postTokenBalances?: unknown[];
      logMessages?: string[];
      loadedAddresses?: { writable: string[]; readonly: string[] };
      innerInstructions?: unknown[];
    };
  };
}

/**
 * Read a fixture, deserialize the base64 transaction, and produce a
 * web3.js-shaped `VersionedTransactionResponse`. The returned object
 * is structurally compatible with what `Connection.getTransaction()`
 * would have given us live.
 */
export function loadFixtureResponse(name: string): VersionedTransactionResponse {
  const path = join(FIXTURES_DIR, `${name}.json`);
  const fx = JSON.parse(readFileSync(path, 'utf-8')) as RawFixture;
  const r = fx.response;

  // [base64String, "base64"] tuple — pull the bytes out and deserialize.
  const txBytes = Buffer.from(r.transaction[0], 'base64');
  const versionedTx = VersionedTransaction.deserialize(txBytes);

  const loadedWritable = r.meta.loadedAddresses?.writable?.map((s) => new PublicKey(s)) ?? [];
  const loadedReadonly = r.meta.loadedAddresses?.readonly?.map((s) => new PublicKey(s)) ?? [];

  // The web3.js type uses a discriminated union; we cast through unknown
  // because we're hand-building it from raw RPC JSON.
  return {
    slot: r.slot,
    blockTime: r.blockTime,
    transaction: {
      message: versionedTx.message,
      signatures: versionedTx.signatures.map((s) => Buffer.from(s).toString('base64')),
    },
    meta: {
      err: r.meta.err,
      fee: r.meta.fee,
      preBalances: r.meta.preBalances,
      postBalances: r.meta.postBalances,
      preTokenBalances: r.meta.preTokenBalances ?? [],
      postTokenBalances: r.meta.postTokenBalances ?? [],
      logMessages: r.meta.logMessages ?? [],
      loadedAddresses: { writable: loadedWritable, readonly: loadedReadonly },
      innerInstructions: r.meta.innerInstructions ?? [],
      computeUnitsConsumed: 0,
    },
    version: r.version === 'legacy' ? 'legacy' : 0,
  } as unknown as VersionedTransactionResponse;
}

/**
 * Build a complete ParseInput for the dispatcher. Owner defaults to
 * the first signer (account 0), which is correct for normal
 * single-signer transactions and good enough for parser-level tests.
 */
export function loadFixtureAsParseInput(name: string): ParseInput {
  const response = loadFixtureResponse(name);
  const path = join(FIXTURES_DIR, `${name}.json`);
  const fx = JSON.parse(readFileSync(path, 'utf-8')) as RawFixture;
  const message = response.transaction.message;
  const signerKey =
    'staticAccountKeys' in message ? (message.staticAccountKeys[0]?.toBase58() ?? '') : '';

  return {
    signature: fx.signature as SolanaSignature,
    slot: response.slot,
    blockTime: new Date((response.blockTime ?? 0) * 1000).toISOString() as ISOTimestamp,
    ownerPubkey: signerKey as SolanaPubkey,
    transaction: response,
  };
}

export function fixtureSignature(name: string): string {
  const path = join(FIXTURES_DIR, `${name}.json`);
  const fx = JSON.parse(readFileSync(path, 'utf-8')) as RawFixture;
  return fx.signature;
}
