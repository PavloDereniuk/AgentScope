/**
 * One-off script: fetch Drift v2 perpetuals tx fixtures from mainnet.
 * Saves them in packages/parser/tests/fixtures/ in the same format as other parsers.
 * Run: NODE_OPTIONS="--use-system-ca" tsx --env-file=../.env fetch-drift-fixtures.ts
 *
 * ⚠️ Best-effort only. As of 2026-07, Drift's mainnet order flow has migrated
 * almost entirely to Swift signed-message orders (submitted by keepers), so the
 * classic OUTER place/cancel instructions this script targets are extremely rare
 * in the global feed — a scan of >6000 recent tx found zero. The committed
 * drift-* fixtures were therefore constructed to the official Drift IDL layout
 * (see packages/parser/src/drift/idl.json and A.6 notes in POST-MVP-ROADMAP.md),
 * not captured live. This script is kept so that if/when a monitored agent emits
 * classic calls, real fixtures can be captured to replace the constructed ones.
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
if (!HELIUS_API_KEY) {
  console.error('HELIUS_API_KEY not set');
  process.exit(1);
}

const RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

// Verified on-chain (executable BPF program). State PDA
// 5zpq7DvB6UdFFvpmBPspGPNfUGoBRRCE2HHg5u3gxcsN confirmed owned by this program.
const DRIFT = 'dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH';

const FIXTURES_DIR = join(import.meta.dirname, '../packages/parser/tests/fixtures');

// Anchor discriminators: sha256("global:<snake_case_name>")[0..8]. Verified against
// the official Drift IDL (on-chain v2.150.0 + github protocol-v2 v2.162.0).
const TARGET_DISCS: Record<string, string> = {
  '45a15dca787e4cb9': 'place-perp-order',
  '3c3f327b0cc53cbe': 'place-orders',
  d53301bb6cdce6e0: 'place-and-take-perp-order',
  '5f81edf00831df84': 'cancel-order',
  eee15f9ee36708c2: 'cancel-orders',
  f223c68952e1f2b6: 'deposit',
  b712469c946da122: 'withdraw',
};

const TARGETS: Record<string, number> = {
  'place-perp-order': 2,
  'place-orders': 1,
  'place-and-take-perp-order': 2,
  'cancel-order': 2,
  'cancel-orders': 1,
  deposit: 1,
  withdraw: 1,
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

/** Which Drift instruction (if any) does this fixture's outer instruction data match? */
function detectInstruction(fixture: unknown): string | null {
  const f = fixture as { response: { transaction: [string, string] } };
  const txHex = Buffer.from(f.response.transaction[0], 'base64').toString('hex');
  for (const [disc, name] of Object.entries(TARGET_DISCS)) {
    if (txHex.includes(disc)) return name;
  }
  return null;
}

async function fetchDriftFixtures(): Promise<void> {
  console.log('\nFetching Drift fixtures (best-effort — classic calls are rare, see header)...');
  const saved: Record<string, number> = Object.fromEntries(
    Object.keys(TARGETS).map((k) => [k, 0]),
  );

  let before: string | undefined;
  const MAX_PAGES = 30;

  for (let page = 0; page < MAX_PAGES; page++) {
    const done = Object.entries(TARGETS).every(([name, want]) => (saved[name] ?? 0) >= want);
    if (done) break;

    const sigs = (await rpc('getSignaturesForAddress', [
      DRIFT,
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
        const name = `drift-${kind}-${idx}`;
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

await fetchDriftFixtures();
console.log('\nDone.');
