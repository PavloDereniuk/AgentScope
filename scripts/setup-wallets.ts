/**
 * 9.3 — Generate 3 keypairs for demo agents (mainnet-safe, no airdrop).
 *
 * Run: pnpm --filter @agentscope/scripts setup-wallets
 *
 * Writes to wallets/ (already in .gitignore).
 * Fund each wallet with a small amount of SOL before running demo scripts.
 * After running, register each wallet as an agent in the AgentScope dashboard
 * and set AGENTSCOPE_AGENT_TOKEN_<NAME> in .env.
 */

import { Connection, Keypair, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';

const RPC_URL =
  process.env['SOLANA_RPC_URL'] ?? 'https://api.mainnet-beta.solana.com';
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
    // mode 0o600: secret bytes are owner-readable only on Unix; Windows
    // ignores the bit harmlessly. Matches gen-curl-wallet / gen-eliza-wallet.
    writeFileSync(path, JSON.stringify(Array.from(keypair.secretKey)), { mode: 0o600 });
    console.info(`[${name}] generated ${keypair.publicKey.toBase58()}`);
  }

  const bal = await connection.getBalance(keypair.publicKey);
  const solBal = bal / LAMPORTS_PER_SOL;
  const status = solBal >= 0.005 ? '✓' : '⚠ needs funding';
  console.info(`[${name}] ${keypair.publicKey.toBase58()} — ${solBal.toFixed(6)} SOL ${status}`);
}

console.info('\nNext steps:');
console.info('1. Fund each wallet with at least 0.01 SOL (mainnet)');
console.info('2. Open the AgentScope dashboard → New Agent for each wallet address');
console.info('3. Copy each Ingest Token and add to .env:');
console.info('   AGENTSCOPE_AGENT_TOKEN_TRADER=...');
console.info('   AGENTSCOPE_AGENT_TOKEN_YIELD=...');
console.info('   AGENTSCOPE_AGENT_TOKEN_NFT=...');
console.info('4. Run: pnpm --filter @agentscope/scripts demo-trader');
