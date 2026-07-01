/**
 * One-off script: fetch 5 Orca Whirlpools swap tx fixtures from mainnet.
 * Saves them in packages/parser/tests/fixtures/ in the same format as other parsers.
 * Run: tsx --env-file=../.env fetch-orca-fixtures.ts
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
if (!HELIUS_API_KEY) {
  console.error('HELIUS_API_KEY not set');
  process.exit(1);
}

const RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

const ORCA_WHIRLPOOL = 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc';

const FIXTURES_DIR = join(import.meta.dirname, '../packages/parser/tests/fixtures');

// Orca Whirlpools Anchor discriminators (sha256("global:<name>")[0..8])
const SWAP_DISCS = new Set([
  'f8c69e91e17587c8', // swap (v1)
  '2b04ed0b1ac91e62', // swap_v2
  'c360ed6c44a2dbe6', // two_hop_swap
  'ba8fd11dfe02c275', // two_hop_swap_v2
]);

async function rpc(method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const json = (await res.json()) as { result?: unknown; error?: { message: string } };
  if (json.error) throw new Error(`RPC ${method}: ${json.error.message}`);
  return json.result;
}

async function getRecentSignatures(programId: string, limit = 50): Promise<string[]> {
  const sigs = (await rpc('getSignaturesForAddress', [
    programId,
    { limit, commitment: 'confirmed' },
  ])) as { signature: string; err: unknown }[];
  return sigs.filter((s) => !s.err).map((s) => s.signature);
}

async function fetchTxAsFixture(signature: string): Promise<unknown | null> {
  const result = await rpc('getTransaction', [
    signature,
    {
      encoding: 'base64',
      maxSupportedTransactionVersion: 0,
      commitment: 'confirmed',
    },
  ]);
  if (!result) return null;
  const r = result as {
    slot: number;
    blockTime: number | null;
    version: number | 'legacy';
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
  return {
    signature,
    response: {
      slot: r.slot,
      blockTime: r.blockTime,
      version: r.version ?? 'legacy',
      transaction: r.transaction,
      meta: {
        err: r.meta.err,
        fee: r.meta.fee,
        preBalances: r.meta.preBalances,
        postBalances: r.meta.postBalances,
        preTokenBalances: r.meta.preTokenBalances ?? [],
        postTokenBalances: r.meta.postTokenBalances ?? [],
        logMessages: r.meta.logMessages ?? [],
        loadedAddresses: r.meta.loadedAddresses ?? { writable: [], readonly: [] },
        innerInstructions: r.meta.innerInstructions ?? [],
      },
    },
  };
}

/** Check outer [1] invocation AND that the instruction is a swap (not add_liquidity etc.) */
function isOrcaSwapOuter(fixture: unknown): boolean {
  const f = fixture as { response: { meta: { logMessages?: string[] } } };
  const logs = f.response.meta.logMessages ?? [];

  // Must be outer-level Orca invocation
  if (!logs.some((l) => l.includes(`Program ${ORCA_WHIRLPOOL} invoke [1]`))) return false;

  // Must contain a swap instruction discriminator in logs (swap_v2 emits no special log,
  // but the tx data itself is what matters — we decode below)
  return true;
}

/** Inspect whether any outer instruction of this fixture is an Orca swap. */
function hasOrcaSwapInstruction(fixture: unknown): boolean {
  const f = fixture as {
    response: {
      transaction: [string, string];
      meta: { loadedAddresses?: { writable: string[]; readonly: string[] } };
    };
  };

  // We can't easily decode without importing web3.js here; use log-based detection
  // plus a lightweight check on the transaction bytes for the discriminator.
  const txBytes = Buffer.from(f.response.transaction[0], 'base64');

  // Look for any of the swap discriminators in the raw tx bytes (not perfect but reliable
  // for outer instructions whose data appears after the message header).
  const txHex = txBytes.toString('hex');
  for (const disc of SWAP_DISCS) {
    if (txHex.includes(disc)) return true;
  }
  return false;
}

async function fetchOrcaFixtures(count: number): Promise<void> {
  console.log(`\nFetching ${count} Orca Whirlpools swap fixtures...`);
  const sigs = await getRecentSignatures(ORCA_WHIRLPOOL, 100);
  console.log(`  Found ${sigs.length} recent non-error tx`);

  let saved = 0;
  for (const sig of sigs) {
    if (saved >= count) break;
    try {
      await new Promise((r) => setTimeout(r, 300));
      const fixture = await fetchTxAsFixture(sig);
      if (!fixture) {
        console.log(`  skip ${sig.slice(0, 8)}: no result`);
        continue;
      }
      if (!isOrcaSwapOuter(fixture)) {
        console.log(`  skip ${sig.slice(0, 8)}: not outer Orca invocation`);
        continue;
      }
      if (!hasOrcaSwapInstruction(fixture)) {
        console.log(`  skip ${sig.slice(0, 8)}: no swap discriminator`);
        continue;
      }
      const name = `orca-${saved + 1}`;
      const path = join(FIXTURES_DIR, `${name}.json`);
      writeFileSync(path, JSON.stringify(fixture, null, 2));
      console.log(`  ✅ saved ${name}.json (${sig.slice(0, 8)}...)`);
      saved++;
    } catch (e) {
      console.log(`  skip ${sig.slice(0, 8)}: ${e instanceof Error ? e.message : e}`);
    }
  }
  console.log(`  Saved ${saved}/${count} fixtures`);
}

await fetchOrcaFixtures(5);
console.log('\nDone.');
