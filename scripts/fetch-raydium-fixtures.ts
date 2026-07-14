/**
 * One-off script: fetch 5 Raydium AMM v4 + 5 CLMM swap tx fixtures from mainnet.
 * Saves them in packages/parser/tests/fixtures/ in the same format as Jupiter/Kamino.
 * Run: tsx --env-file=../.env fetch-raydium-fixtures.ts
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
if (!HELIUS_API_KEY) {
  console.error('HELIUS_API_KEY not set');
  process.exit(1);
}

const RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

const RAYDIUM_AMM_V4 = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8';
const RAYDIUM_CLMM = 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK';

const FIXTURES_DIR = join(import.meta.dirname, '../packages/parser/tests/fixtures');

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

async function getRecentSwapSignatures(programId: string, limit = 30): Promise<string[]> {
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

/**
 * Check if a tx directly invokes the given programId as an outer instruction
 * (i.e. program is not only called via CPI). We decode the base64 tx to check.
 * This filters out txs where Raydium is only called via CPI from Jupiter etc.
 */
function hasOuterInstruction(fixture: unknown, programId: string): boolean {
  const f = fixture as {
    response: {
      transaction: [string, string];
      meta: { loadedAddresses?: { writable: string[]; readonly: string[] } };
    };
  };
  // Decode the transaction bytes to read the outer instruction program IDs
  const txBytes = Buffer.from(f.response.transaction[0], 'base64');
  // First byte is version prefix (0 = v0, else legacy). Skip it for v0.
  let offset = 0;
  const firstByte = txBytes[0] ?? 0;
  const isVersioned = (firstByte & 0x7f) === 0 && firstByte !== 0;
  if (isVersioned) offset = 1; // skip version prefix

  // After version: signatures count (compact-u16) + signatures
  // We just need to find the account addresses. For our purposes,
  // we look for the programId string in logMessages which is reliable.
  const logs: string[] = (f as { response: { meta: { logMessages?: string[] } } }).response.meta
    .logMessages ?? [];
  return logs.some((l) => l.includes(`Program ${programId} invoke [1]`));
}

async function fetchFixtures(programId: string, prefix: string, count: number): Promise<void> {
  console.log(`\nFetching ${count} ${prefix} fixtures from ${programId.slice(0, 8)}...`);
  const sigs = await getRecentSwapSignatures(programId, 60);
  console.log(`  Found ${sigs.length} recent non-error tx`);

  let saved = 0;
  for (const sig of sigs) {
    if (saved >= count) break;
    try {
      await new Promise((r) => setTimeout(r, 250));
      const fixture = await fetchTxAsFixture(sig);
      if (!fixture) {
        console.log(`  skip ${sig.slice(0, 8)}: no result`);
        continue;
      }
      if (!hasOuterInstruction(fixture, programId)) {
        console.log(`  skip ${sig.slice(0, 8)}: program only in CPI`);
        continue;
      }
      const name = `${prefix}-${saved + 1}`;
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

await fetchFixtures(RAYDIUM_AMM_V4, 'raydium-amm', 5);
await fetchFixtures(RAYDIUM_CLMM, 'raydium-clmm', 5);
console.log('\nDone.');
