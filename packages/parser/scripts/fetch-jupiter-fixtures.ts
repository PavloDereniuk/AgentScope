/**
 * Fetch real Jupiter v6 swap transactions from mainnet and save them
 * as JSON fixtures for the parser TDD tests (task 2.3).
 *
 * Why mainnet: Jupiter aggregator is deployed only on mainnet — devnet
 * pools don't have liquidity, so devnet "swaps" don't exist. We use
 * the same Helius API key (Helius keys work across networks) and only
 * read public on-chain data, so this carries no security cost.
 *
 * Usage:
 *   HELIUS_API_KEY=... pnpm tsx scripts/fetch-jupiter-fixtures.ts
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const apiKey = process.env['HELIUS_API_KEY'];
if (!apiKey) {
  console.error('HELIUS_API_KEY env var is required');
  process.exit(1);
}

const RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${apiKey}`;
const JUPITER_V6 = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
const FIXTURES_DIR = join(import.meta.dirname, '..', 'tests', 'fixtures');
const TARGET_COUNT = 5;
const CANDIDATE_LIMIT = 30; // pull a few extra so we can filter to real swaps

interface RpcResponse<T> {
  jsonrpc: '2.0';
  id: number | string;
  result?: T;
  error?: { code: number; message: string };
}

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const res = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${await res.text()}`);
  const json = (await res.json()) as RpcResponse<T>;
  if (json.error) throw new Error(`RPC ${method}: ${json.error.message}`);
  if (json.result === undefined) throw new Error(`RPC ${method} returned no result`);
  return json.result;
}

interface Signature {
  signature: string;
  slot: number;
  err: unknown;
  blockTime: number | null;
}

interface ParsedTxAccountKey {
  pubkey: string;
  signer: boolean;
  source: 'transaction' | 'lookupTable';
  writable: boolean;
}

interface JsonParsedTx {
  meta: {
    err: unknown;
    fee: number;
    logMessages?: string[];
  } | null;
  transaction: {
    message: {
      accountKeys: ParsedTxAccountKey[];
      instructions: { programId: string }[];
    };
  };
  slot: number;
  blockTime: number | null;
  version: 'legacy' | 0;
}

async function main() {
  mkdirSync(FIXTURES_DIR, { recursive: true });

  console.log(`fetching last ${CANDIDATE_LIMIT} signatures for Jupiter v6...`);
  const sigs = await rpc<Signature[]>('getSignaturesForAddress', [
    JUPITER_V6,
    { limit: CANDIDATE_LIMIT },
  ]);
  console.log(`got ${sigs.length} candidates`);

  const successful = sigs.filter((s) => s.err === null);
  console.log(`${successful.length} successful, will fetch each until we have ${TARGET_COUNT} swaps`);

  const collected: { signature: string; raw: unknown }[] = [];

  for (const sig of successful) {
    if (collected.length >= TARGET_COUNT) break;

    try {
      // First pass: jsonParsed to confirm Jupiter is in the top-level instructions
      // (not just an inner CPI from some routing aggregator).
      const parsed = await rpc<JsonParsedTx>('getTransaction', [
        sig.signature,
        { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 },
      ]);

      const hasJupiterTopLevel = parsed.transaction.message.instructions.some(
        (ix) => ix.programId === JUPITER_V6,
      );
      if (!hasJupiterTopLevel) {
        console.log(`  skip ${sig.signature.slice(0, 12)}... (jupiter is inner CPI only)`);
        continue;
      }

      // Second pass: base64 encoding so we have raw instruction bytes
      // for the parser to decode.
      const raw = await rpc<unknown>('getTransaction', [
        sig.signature,
        { encoding: 'base64', maxSupportedTransactionVersion: 0 },
      ]);

      collected.push({ signature: sig.signature, raw });
      console.log(`  + ${sig.signature.slice(0, 12)}... (slot ${sig.slot})`);

      // Be polite to the free tier (10 req/sec).
      await new Promise((r) => setTimeout(r, 200));
    } catch (err) {
      console.error(`  ! ${sig.signature.slice(0, 12)}...: ${(err as Error).message}`);
    }
  }

  if (collected.length < TARGET_COUNT) {
    console.warn(`only collected ${collected.length}/${TARGET_COUNT} fixtures — try increasing CANDIDATE_LIMIT`);
  }

  collected.forEach((c, i) => {
    const file = join(FIXTURES_DIR, `jupiter-swap-${i + 1}.json`);
    writeFileSync(file, JSON.stringify({ signature: c.signature, response: c.raw }, null, 2));
    console.log(`  wrote ${file}`);
  });

  console.log(`\n✅ saved ${collected.length} Jupiter v6 fixtures`);
}

main().catch((err) => {
  console.error('\n❌ fetch failed:', err);
  process.exit(1);
});
