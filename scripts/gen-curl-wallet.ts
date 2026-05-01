/**
 * One-shot: generate a fresh keypair for the L0 / curl test agent (Epic 15).
 * Writes to ../wallets/curl-trader.keypair.json (gitignored). Refuses to
 * overwrite an existing file so re-runs can't accidentally lose funds.
 *
 * Run: cd scripts && npx tsx gen-curl-wallet.ts
 */

import { Keypair } from '@solana/web3.js';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';

const PATH = '../wallets/curl-trader.keypair.json';

if (existsSync(PATH)) {
  console.error(`Refusing to overwrite existing keypair: ${PATH}`);
  process.exit(1);
}

mkdirSync('../wallets', { recursive: true });
const kp = Keypair.generate();
writeFileSync(PATH, JSON.stringify(Array.from(kp.secretKey)));

console.log('');
console.log('  ✓ curl/L0 wallet generated');
console.log('');
console.log(`  PUBKEY: ${kp.publicKey.toBase58()}`);
console.log(`  FILE:   AgentScope/wallets/curl-trader.keypair.json`);
console.log('');
console.log('  Next:');
console.log('   1. Fund the address with ≥ 0.02 SOL on mainnet (optional — needed only if the agent will sign txs)');
console.log('   2. AgentScope dashboard → New Agent → paste the PUBKEY');
console.log('   3. Copy the Ingest Token → use as Authorization: Bearer <token> on POST /v1/spans');
