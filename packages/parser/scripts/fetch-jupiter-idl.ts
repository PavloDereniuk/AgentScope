/**
 * Fetch the Jupiter v6 Anchor IDL from mainnet and freeze it as a
 * JSON file inside the parser package (task 2.6).
 *
 * Anchor stores program IDLs at a deterministic PDA derived from
 * the program ID — `Program.fetchIdl()` reads that account and
 * decompresses the gzipped JSON. We hit Helius mainnet (same key
 * as the fixture fetcher) and persist the result so the parser
 * doesn't need network access at test time.
 *
 * Usage:
 *   HELIUS_API_KEY=... pnpm tsx scripts/fetch-jupiter-idl.ts
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AnchorProvider, Program, Wallet } from '@coral-xyz/anchor';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';

const apiKey = process.env['HELIUS_API_KEY'];
if (!apiKey) {
  console.error('HELIUS_API_KEY env var is required');
  process.exit(1);
}

const RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${apiKey}`;
const JUPITER_V6 = new PublicKey('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4');
const OUT_DIR = join(import.meta.dirname, '..', 'src', 'jupiter');
const OUT_FILE = join(OUT_DIR, 'idl.json');

async function main() {
  const connection = new Connection(RPC_URL, 'confirmed');

  // fetchIdl needs an AnchorProvider; the wallet is never used for
  // a read-only IDL fetch but the type system requires one.
  const wallet = new Wallet(Keypair.generate());
  const provider = new AnchorProvider(connection, wallet, {
    commitment: 'confirmed',
  });

  console.log(`fetching IDL for ${JUPITER_V6.toBase58()}...`);
  const idl = await Program.fetchIdl(JUPITER_V6, provider);

  if (!idl) {
    console.error('❌ no IDL account found on-chain for this program');
    process.exit(1);
  }

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT_FILE, JSON.stringify(idl, null, 2));

  const stat = JSON.stringify(idl);
  console.log(`✅ wrote ${OUT_FILE}`);
  console.log(`   size: ${(stat.length / 1024).toFixed(1)} KB`);
  console.log(`   instructions: ${(idl as { instructions?: unknown[] }).instructions?.length ?? 0}`);
  console.log(`   accounts: ${(idl as { accounts?: unknown[] }).accounts?.length ?? 0}`);
  console.log(`   types: ${(idl as { types?: unknown[] }).types?.length ?? 0}`);
}

main().catch((err) => {
  console.error('\n❌ fetch failed:', err);
  process.exit(1);
});
