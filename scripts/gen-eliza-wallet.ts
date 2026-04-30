/**
 * One-shot: generate a fresh keypair for the ElizaOS live agent (10.7b).
 * Writes to ../wallets/eliza-trader.keypair.json (gitignored). Refuses to
 * overwrite an existing file so re-runs can't accidentally lose funds.
 *
 * Run: pnpm --filter @agentscope/scripts exec tsx gen-eliza-wallet.ts
 *  (or: cd scripts && npx tsx gen-eliza-wallet.ts)
 */

import { Keypair } from '@solana/web3.js';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';

const PATH = '../wallets/eliza-trader.keypair.json';

if (existsSync(PATH)) {
  console.error(`Refusing to overwrite existing keypair: ${PATH}`);
  process.exit(1);
}

mkdirSync('../wallets', { recursive: true });
const kp = Keypair.generate();
writeFileSync(PATH, JSON.stringify(Array.from(kp.secretKey)));

console.log('');
console.log('  ✓ ElizaOS wallet generated');
console.log('');
console.log(`  PUBKEY: ${kp.publicKey.toBase58()}`);
console.log(`  FILE:   AgentScope/wallets/eliza-trader.keypair.json`);
console.log('');
console.log('  Next:');
console.log('   1. Fund the address with ≥ 0.02 SOL on mainnet');
console.log('   2. AgentScope dashboard → New Agent → paste the PUBKEY');
console.log('   3. Copy the Ingest Token → AGENTSCOPE_AGENT_TOKEN in Agents/ElizaOS/.env');
