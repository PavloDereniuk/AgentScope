/**
 * 9.6 — Trigger anomaly: forces high-slippage reasoning + error spans to
 * exercise the slippage and error-rate alert rules in the detector.
 *
 * Defaults to DEVNET to avoid spending real SOL on test transactions.
 * Set ANOMALY_NETWORK=mainnet only if you want to test with real funds.
 *
 * Run: pnpm --filter @agentscope/scripts trigger-anomaly
 *
 * Env vars:
 *   ANOMALY_NETWORK             (default: devnet — safe for testing)
 *   SOLANA_RPC_URL              (overrides ANOMALY_NETWORK RPC if set)
 *   AGENTSCOPE_API_URL
 *   AGENTSCOPE_AGENT_TOKEN_TRADER   (reuses trader agent)
 */

import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import { readFileSync } from 'node:fs';
import { initAgentScope, traced } from '@agentscopehq/agent-kit-sdk';

const ANOMALY_NETWORK = process.env['ANOMALY_NETWORK'] ?? 'devnet';
const DEFAULT_RPC =
  ANOMALY_NETWORK === 'mainnet'
    ? 'https://api.mainnet-beta.solana.com'
    : 'https://api.devnet.solana.com';
const RPC_URL = process.env['SOLANA_RPC_URL'] ?? DEFAULT_RPC;
const API_URL = process.env['AGENTSCOPE_API_URL'] ?? 'http://localhost:3000';
const AGENT_TOKEN = process.env['AGENTSCOPE_AGENT_TOKEN_TRADER'] ?? '';

if (!AGENT_TOKEN) {
  console.error('AGENTSCOPE_AGENT_TOKEN_TRADER is required');
  process.exit(1);
}

const connection = new Connection(RPC_URL, 'confirmed');
const secretKey = JSON.parse(readFileSync('../wallets/trader.keypair.json', 'utf-8')) as number[];
const wallet = Keypair.fromSecretKey(Uint8Array.from(secretKey));

const sdk = initAgentScope({ apiUrl: API_URL, agentToken: AGENT_TOKEN });

console.info(`Triggering anomaly scenario on ${ANOMALY_NETWORK}...`);
if (ANOMALY_NETWORK === 'mainnet') {
  console.warn('WARNING: running on mainnet — real SOL will be spent on tx fees');
}

// 1. High-slippage span (triggers slippage alert rule)
await traced(
  'execute_swap_anomaly',
  async () => {
    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: wallet.publicKey,
        toPubkey: wallet.publicKey,
        lamports: Math.floor(0.001 * LAMPORTS_PER_SOL),
      }),
    );
    const sig = await sendAndConfirmTransaction(connection, tx, [wallet]);
    console.info(`High-slippage swap tx: ${sig}`);
    return sig;
  },
  {
    'solana.action': 'swap',
    'swap.slippage_bps': 5000, // 50% — way above any sane threshold
    'swap.from': 'SOL',
    'swap.to': 'USDC',
    'swap.amount_usd': 500,
  },
);

// 2. Deliberately failing span (triggers error-rate alert rule)
try {
  await traced(
    'execute_swap_failed',
    async () => {
      throw new Error('InsufficientLiquidity: price impact too high');
    },
    { 'solana.action': 'swap', 'swap.from': 'USDC', 'swap.to': 'SOL', 'swap.amount_usd': 200 },
  );
} catch {
  console.info('Recorded failing swap span (error-rate anomaly)');
}

// Give BatchSpanProcessor time to flush
await new Promise((r) => setTimeout(r, 500));
await sdk.shutdown();

console.info('\nAnomaly triggered!');
console.info('Check the AgentScope dashboard → Alerts feed within ~60s.');
