/**
 * Fetch the Kamino Lend Anchor IDL from mainnet (task 2.9).
 *
 * Same approach as fetch-jupiter-idl: pull from the deterministic
 * Anchor IDL PDA and freeze the JSON inside the parser package so
 * test runs don't need network access.
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
const KAMINO_LEND = new PublicKey('KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD');
const OUT_DIR = join(import.meta.dirname, '..', 'src', 'kamino');
const OUT_FILE = join(OUT_DIR, 'idl.json');

async function main() {
  const connection = new Connection(RPC_URL, 'confirmed');
  const wallet = new Wallet(Keypair.generate());
  const provider = new AnchorProvider(connection, wallet, { commitment: 'confirmed' });

  console.log(`fetching IDL for ${KAMINO_LEND.toBase58()}...`);
  const idl = await Program.fetchIdl(KAMINO_LEND, provider);
  if (!idl) {
    console.error('❌ no IDL account found on-chain');
    process.exit(1);
  }

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT_FILE, JSON.stringify(idl, null, 2));

  const stat = JSON.stringify(idl);
  console.log(`✅ wrote ${OUT_FILE}`);
  console.log(`   size: ${(stat.length / 1024).toFixed(1)} KB`);
  console.log(`   instructions: ${(idl as { instructions?: unknown[] }).instructions?.length ?? 0}`);
}

main().catch((err) => {
  console.error('\n❌ fetch failed:', err);
  process.exit(1);
});
