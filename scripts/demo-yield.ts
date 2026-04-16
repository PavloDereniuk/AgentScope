/**
 * 9.5 — Demo yield-bot: Kamino-style deposit/withdraw loop.
 *
 * Simulates a yield optimization agent that evaluates APY and decides
 * whether to deposit or withdraw from a Kamino vault.
 * Actions are mocked with 0.001 SOL transfers to self; reasoning is real OTel spans.
 *
 * Run: pnpm --filter @agentscope/scripts demo-yield
 *
 * Env vars:
 *   SOLANA_RPC_URL            (default: mainnet-beta public RPC)
 *   AGENTSCOPE_API_URL
 *   AGENTSCOPE_AGENT_TOKEN_YIELD
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
import { initAgentScope, traced } from '@agentscope/agent-kit-sdk';

const RPC_URL = process.env['SOLANA_RPC_URL'] ?? 'https://api.mainnet-beta.solana.com';
const API_URL = process.env['AGENTSCOPE_API_URL'] ?? 'http://localhost:3000';
const AGENT_TOKEN = process.env['AGENTSCOPE_AGENT_TOKEN_YIELD'] ?? '';
const LOOP_INTERVAL_MS = Number(process.env['DEMO_INTERVAL_MS'] ?? '60000');

if (!AGENT_TOKEN) {
  console.error('AGENTSCOPE_AGENT_TOKEN_YIELD is required');
  process.exit(1);
}

const MIN_SOL_BALANCE = 0.005;

const connection = new Connection(RPC_URL, 'confirmed');
const secretKey = JSON.parse(readFileSync('../wallets/yield-bot.keypair.json', 'utf-8')) as number[];
const wallet = Keypair.fromSecretKey(Uint8Array.from(secretKey));

console.info(`Yield-bot wallet: ${wallet.publicKey.toBase58()}`);

const balance = await connection.getBalance(wallet.publicKey);
const solBalance = balance / LAMPORTS_PER_SOL;
if (solBalance < MIN_SOL_BALANCE) {
  console.error(
    `Insufficient balance: ${solBalance.toFixed(6)} SOL. Fund wallet with at least ${MIN_SOL_BALANCE} SOL before running.`,
  );
  process.exit(1);
}
console.info(`Balance: ${solBalance.toFixed(6)} SOL`);

const sdk = initAgentScope({ apiUrl: API_URL, agentToken: AGENT_TOKEN });

let running = true;
process.on('SIGINT', () => { running = false; });
process.on('SIGTERM', () => { running = false; });

// Alternate between deposit and withdraw each cycle
let lastAction: 'deposit' | 'withdraw' = 'withdraw';

async function runYieldCycle(cycle: number): Promise<void> {
  await traced('yield_cycle', async () => {
    // 1. Fetch vault APY
    const apy = await traced(
      'fetch_vault_apy',
      async () => {
        const mockApy = 4 + Math.random() * 8; // 4–12%
        console.info(`[cycle ${cycle}] Kamino SOL vault APY: ${mockApy.toFixed(2)}%`);
        return mockApy;
      },
      { 'vault.protocol': 'kamino', 'vault.asset': 'SOL' },
    );

    // 2. Decide action
    const action: 'deposit' | 'withdraw' = apy > 6 && lastAction === 'withdraw'
      ? 'deposit'
      : 'withdraw';
    lastAction = action;

    await traced('decide_action', async () => {
      console.info(`[cycle ${cycle}] decision: ${action} (APY=${apy.toFixed(2)}%)`);
    }, { 'decision.action': action, 'vault.apy_pct': apy });

    // 3. Execute (devnet mock)
    const sig = await traced(
      `execute_${action}`,
      async () => {
        const tx = new Transaction().add(
          SystemProgram.transfer({
            fromPubkey: wallet.publicKey,
            toPubkey: wallet.publicKey,
            lamports: Math.floor(0.001 * LAMPORTS_PER_SOL),
          }),
        );
        const signature = await sendAndConfirmTransaction(connection, tx, [wallet]);
        console.info(`[cycle ${cycle}] ${action} tx: ${signature}`);
        return signature;
      },
      { 'kamino.action': action, 'kamino.amount_sol': 0.1 },
    );

    console.info(`[cycle ${cycle}] done — sig: ${sig}`);
  }, { 'cycle.index': cycle });
}

let cycle = 0;
while (running) {
  cycle += 1;
  try {
    await runYieldCycle(cycle);
  } catch (err) {
    console.error(`[cycle ${cycle}] error:`, err);
  }
  if (running) await new Promise((r) => setTimeout(r, LOOP_INTERVAL_MS));
}

await sdk.shutdown();
console.info('Yield-bot stopped.');
