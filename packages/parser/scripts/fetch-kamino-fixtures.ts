/**
 * Fetch real Kamino Lend transactions from mainnet (task 2.4).
 *
 * Like the Jupiter fetcher, this captures base64-encoded responses
 * from getTransaction so the parser can decode raw instruction bytes
 * via Anchor IDL. We try to maximize *diversity* of instruction
 * discriminators across the 5 saved fixtures so the TDD work in
 * task 2.8-2.10 covers deposit / withdraw / borrow / repay /
 * liquidate variants — but if mainnet only gave us deposits in the
 * sample window, we save 5 deposits and the parser tests will be
 * narrower than ideal. That's an acceptable MVP trade-off.
 *
 * Usage:
 *   HELIUS_API_KEY=... pnpm tsx scripts/fetch-kamino-fixtures.ts
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const apiKey = process.env['HELIUS_API_KEY'];
if (!apiKey) {
  console.error('HELIUS_API_KEY env var is required');
  process.exit(1);
}

const RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${apiKey}`;
const KAMINO_LEND = 'KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD';
const FIXTURES_DIR = join(import.meta.dirname, '..', 'tests', 'fixtures');
const TARGET_COUNT = 5;
const CANDIDATE_LIMIT = 80; // need a wider net for instruction diversity

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

interface JsonParsedTx {
  meta: { err: unknown; fee: number } | null;
  transaction: {
    message: {
      instructions: { programId: string; data?: string }[];
    };
  };
  slot: number;
  version: 'legacy' | 0;
}

/**
 * Extract the discriminator (first 8 bytes hex) of a Kamino Lend
 * instruction at the top level. Used as a coarse instruction-type
 * grouping key — Anchor instructions all share an 8-byte sha256
 * prefix derived from the instruction name.
 */
function topLevelKaminoDiscriminator(parsed: JsonParsedTx): string | null {
  for (const ix of parsed.transaction.message.instructions) {
    if (ix.programId !== KAMINO_LEND) continue;
    if (!ix.data) return null;
    // jsonParsed encoding gives us base58 strings for program data on
    // unparsed programs. Decode the first 8 bytes to hex for grouping.
    try {
      // Lazy base58 → bytes via Buffer-from for the first ~12 chars
      // (8 bytes encode to 11-12 base58 chars typically).
      const bs58 = require('bs58').default ?? require('bs58');
      const bytes = bs58.decode(ix.data) as Uint8Array;
      return Buffer.from(bytes.slice(0, 8)).toString('hex');
    } catch {
      return null;
    }
  }
  return null;
}

async function main() {
  mkdirSync(FIXTURES_DIR, { recursive: true });

  console.log(`fetching last ${CANDIDATE_LIMIT} signatures for Kamino Lend...`);
  const sigs = await rpc<Signature[]>('getSignaturesForAddress', [
    KAMINO_LEND,
    { limit: CANDIDATE_LIMIT },
  ]);
  console.log(`got ${sigs.length} candidates`);

  const successful = sigs.filter((s) => s.err === null);
  console.log(`${successful.length} successful, scanning for instruction diversity...`);

  // Map<discriminator, { signature, raw }> — first occurrence wins
  const byDisc = new Map<string, { signature: string; raw: unknown; slot: number }>();
  // Fallback bucket for txs we couldn't classify
  const unclassified: { signature: string; raw: unknown; slot: number }[] = [];

  for (const sig of successful) {
    if (byDisc.size >= TARGET_COUNT) break;

    try {
      const parsed = await rpc<JsonParsedTx>('getTransaction', [
        sig.signature,
        { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 },
      ]);

      const hasKaminoTopLevel = parsed.transaction.message.instructions.some(
        (ix) => ix.programId === KAMINO_LEND,
      );
      if (!hasKaminoTopLevel) {
        await new Promise((r) => setTimeout(r, 150));
        continue;
      }

      const disc = topLevelKaminoDiscriminator(parsed);
      const raw = await rpc<unknown>('getTransaction', [
        sig.signature,
        { encoding: 'base64', maxSupportedTransactionVersion: 0 },
      ]);

      if (disc && !byDisc.has(disc)) {
        byDisc.set(disc, { signature: sig.signature, raw, slot: sig.slot });
        console.log(`  + ${sig.signature.slice(0, 12)}... disc=${disc} (slot ${sig.slot})`);
      } else if (disc) {
        console.log(`  ↻ ${sig.signature.slice(0, 12)}... disc=${disc} (already have)`);
      } else {
        unclassified.push({ signature: sig.signature, raw, slot: sig.slot });
        console.log(`  ? ${sig.signature.slice(0, 12)}... (no discriminator)`);
      }

      await new Promise((r) => setTimeout(r, 200));
    } catch (err) {
      console.error(`  ! ${sig.signature.slice(0, 12)}...: ${(err as Error).message}`);
    }
  }

  let collected = Array.from(byDisc.values());
  // Top up with unclassified entries if we didn't get enough variety
  while (collected.length < TARGET_COUNT && unclassified.length > 0) {
    const next = unclassified.shift();
    if (next) collected.push(next);
  }
  collected = collected.slice(0, TARGET_COUNT);

  if (collected.length < TARGET_COUNT) {
    console.warn(
      `only collected ${collected.length}/${TARGET_COUNT} fixtures — try increasing CANDIDATE_LIMIT`,
    );
  }

  collected.forEach((c, i) => {
    const file = join(FIXTURES_DIR, `kamino-${i + 1}.json`);
    writeFileSync(file, JSON.stringify({ signature: c.signature, response: c.raw }, null, 2));
    console.log(`  wrote ${file}`);
  });

  console.log(`\n✅ saved ${collected.length} Kamino Lend fixtures`);
  console.log(
    `   discriminators: ${Array.from(byDisc.keys()).join(', ')}`,
  );
}

main().catch((err) => {
  console.error('\n❌ fetch failed:', err);
  process.exit(1);
});
