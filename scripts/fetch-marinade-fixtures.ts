/**
 * One-off script: fetch Marinade Finance liquid-staking tx fixtures from mainnet.
 * Saves them in packages/parser/tests/fixtures/ in the same format as other parsers.
 * Run: tsx --env-file=../.env fetch-marinade-fixtures.ts
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
if (!HELIUS_API_KEY) {
  console.error('HELIUS_API_KEY not set');
  process.exit(1);
}

const RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

// Verified 2026-07-07 via docs.marinade.finance/developers/contract-addresses —
// NOT the address previously written in POST-MVP-ROADMAP.md (that one resolves
// to a nonexistent account on mainnet; see A.7 design notes for the correction).
const MARINADE = 'MarBmsSgKXdrN1egZf5sqe1TMai9K1rChYNDJgjq7aD';

const FIXTURES_DIR = join(import.meta.dirname, '../packages/parser/tests/fixtures');

// Anchor discriminators: sha256("global:<snake_case_name>")[0..8]. Verified
// against real mainnet tx (packages/parser/src/marinade/idl.json).
const TARGET_DISCS: Record<string, string> = {
  f223c68952e1f2b6: 'deposit',
  '1e1e77f0bfe30c10': 'liquid_unstake',
  '61a7906b75be8024': 'order_unstake',
  '3ec6d6c1d59f6cd2': 'claim',
};

// How many fixtures to collect per instruction type.
const TARGETS: Record<string, number> = {
  deposit: 2,
  liquid_unstake: 2,
  order_unstake: 1,
  claim: 1,
};

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

async function fetchTxAsFixture(signature: string): Promise<unknown | null> {
  const result = await rpc('getTransaction', [
    signature,
    { encoding: 'base64', maxSupportedTransactionVersion: 0, commitment: 'confirmed' },
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

/** Which Marinade instruction (if any) does this fixture's outer instruction data match? */
function detectInstruction(fixture: unknown): string | null {
  const f = fixture as { response: { transaction: [string, string] } };
  const txHex = Buffer.from(f.response.transaction[0], 'base64').toString('hex');
  for (const [disc, name] of Object.entries(TARGET_DISCS)) {
    if (txHex.includes(disc)) return name;
  }
  return null;
}

async function fetchMarinadeFixtures(): Promise<void> {
  console.log('\nFetching Marinade fixtures...');
  const saved: Record<string, number> = { deposit: 0, liquid_unstake: 0, order_unstake: 0, claim: 0 };

  let before: string | undefined;
  const MAX_PAGES = 20;

  for (let page = 0; page < MAX_PAGES; page++) {
    const done = Object.entries(TARGETS).every(([name, want]) => (saved[name] ?? 0) >= want);
    if (done) break;

    const sigs = (await rpc('getSignaturesForAddress', [
      MARINADE,
      { limit: 1000, commitment: 'confirmed', ...(before ? { before } : {}) },
    ])) as { signature: string; err: unknown }[];
    if (sigs.length === 0) break;
    before = sigs[sigs.length - 1]?.signature;
    const okSigs = sigs.filter((s) => !s.err).map((s) => s.signature);
    console.log(`  page ${page}: ${sigs.length} sigs, ${okSigs.length} ok`);

    for (const sig of okSigs) {
      const stillWanted = Object.entries(TARGETS).some(
        ([name, want]) => (saved[name] ?? 0) < want,
      );
      if (!stillWanted) break;

      try {
        await new Promise((r) => setTimeout(r, 120));
        const fixture = await fetchTxAsFixture(sig);
        if (!fixture) continue;
        const kind = detectInstruction(fixture);
        if (!kind) continue;
        if ((saved[kind] ?? 0) >= (TARGETS[kind] ?? 0)) continue;

        const idx = (saved[kind] ?? 0) + 1;
        const name = `marinade-${kind.replace(/_/g, '-')}-${idx}`;
        const path = join(FIXTURES_DIR, `${name}.json`);
        writeFileSync(path, JSON.stringify(fixture, null, 2));
        console.log(`  saved ${name}.json (${sig.slice(0, 8)}...)`);
        saved[kind] = idx;
      } catch (e) {
        console.log(`  skip ${sig.slice(0, 8)}: ${e instanceof Error ? e.message : e}`);
      }
    }
  }

  console.log('\nSaved counts:', saved);
}

await fetchMarinadeFixtures();
console.log('\nDone.');
