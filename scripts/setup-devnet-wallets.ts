/**
 * 8.1 — Generate 3 devnet keypairs + airdrop SOL.
 *
 * Run: pnpm --filter @agentscope/scripts setup-wallets
 *
 * Writes to wallets/ (already in .gitignore).
 * After running, register each wallet as an agent in the AgentScope dashboard
 * and set AGENTSCOPE_AGENT_TOKEN_<NAME> in .env.
 */

import { Connection, Keypair, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';

const RPC_URL = process.env['SOLANA_RPC_URL'] ?? 'https://api.devnet.solana.com';
const connection = new Connection(RPC_URL, 'confirmed');

const WALLETS = ['trader', 'yield-bot', 'nft-bot'] as const;

mkdirSync('../wallets', { recursive: true });

for (const name of WALLETS) {
  const path = `../wallets/${name}.keypair.json`;

  let keypair: Keypair;
  if (existsSync(path)) {
    console.info(`[${name}] keypair already exists — skipping generation`);
    const { readFileSync } = await import('node:fs');
    keypair = Keypair.fromSecretKey(
      Uint8Array.from(JSON.parse(readFileSync(path, 'utf-8')) as number[]),
    );
  } else {
    keypair = Keypair.generate();
    writeFileSync(path, JSON.stringify(Array.from(keypair.secretKey)));
    console.info(`[${name}] generated ${keypair.publicKey.toBase58()}`);
  }

  // Airdrop 2 SOL (devnet only)
  try {
    const sig = await connection.requestAirdrop(keypair.publicKey, 2 * LAMPORTS_PER_SOL);
    const latestBlockhash = await connection.getLatestBlockhash();
    await connection.confirmTransaction({ signature: sig, ...latestBlockhash });
    const bal = await connection.getBalance(keypair.publicKey);
    console.info(`[${name}] ${keypair.publicKey.toBase58()} — balance: ${bal / LAMPORTS_PER_SOL} SOL`);
  } catch (err) {
    console.error(`[${name}] airdrop failed (rate limit?): ${String(err)}`);
  }
}

console.info('\nNext steps:');
console.info('1. Open the AgentScope dashboard → New Agent for each wallet address');
console.info('2. Copy each Ingest Token and add to .env:');
console.info('   AGENTSCOPE_AGENT_TOKEN_TRADER=...');
console.info('   AGENTSCOPE_AGENT_TOKEN_YIELD=...');
console.info('   AGENTSCOPE_AGENT_TOKEN_NFT=...');
console.info('3. Run: pnpm --filter @agentscope/scripts demo-trader');
