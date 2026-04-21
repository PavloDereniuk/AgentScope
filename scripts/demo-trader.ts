/**
 * 9.4 — Demo trader agent: Jupiter-style SOL/USDC swap loop.
 *
 * Simulates a trading agent with a SystemProgram.transfer (0.001 SOL to self).
 * The on-chain tx is real and picked up by the ingestion service; reasoning
 * spans are sent to AgentScope via OTel and appear in the reasoning tree.
 *
 * Prerequisites:
 *   pnpm --filter @agentscope/scripts setup-wallets   (fund wallet ≥ 0.01 SOL)
 *   Register agent in dashboard → copy ingest token → set env vars
 *
 * Run: pnpm --filter @agentscope/scripts demo-trader
 *
 * Env vars required:
 *   SOLANA_RPC_URL            (default: mainnet-beta public RPC)
 *   AGENTSCOPE_API_URL        (default: http://localhost:3000)
 *   AGENTSCOPE_AGENT_TOKEN_TRADER
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
import { initAgentScope, trace, traced } from '@agentscope/agent-kit-sdk';

const RPC_URL = process.env['SOLANA_RPC_URL'] ?? 'https://api.mainnet-beta.solana.com';
const API_URL = process.env['AGENTSCOPE_API_URL'] ?? 'http://localhost:3000';
const AGENT_TOKEN = process.env['AGENTSCOPE_AGENT_TOKEN_TRADER'] ?? '';
const LOOP_INTERVAL_MS = Number(process.env['DEMO_INTERVAL_MS'] ?? '60000');

if (!AGENT_TOKEN) {
  console.error('AGENTSCOPE_AGENT_TOKEN_TRADER is required');
  process.exit(1);
}

const MIN_SOL_BALANCE = 0.005;

const connection = new Connection(RPC_URL, 'confirmed');
const secretKey = JSON.parse(readFileSync('../wallets/trader.keypair.json', 'utf-8')) as number[];
const wallet = Keypair.fromSecretKey(Uint8Array.from(secretKey));

console.info(`Trader wallet: ${wallet.publicKey.toBase58()}`);
console.info(`AgentScope API: ${API_URL}`);

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

async function runTradingCycle(cycle: number): Promise<void> {
  await traced('trading_cycle', async () => {
    // 1. Market analysis
    const price = await traced(
      'analyze_market',
      async () => {
        // Simulate fetching SOL/USDC price from an oracle
        const mockPrice = 142 + Math.random() * 16; // 142–158 USDC
        console.info(`[cycle ${cycle}] SOL price: $${mockPrice.toFixed(2)}`);
        return mockPrice;
      },
      { 'solana.mint': 'So11111111111111111111111111111111111111112', 'reasoning.model': 'rule-based' },
    );

    // 2. Decision
    const shouldBuy = price < 150;
    await traced(
      'make_decision',
      async () => {
        console.info(`[cycle ${cycle}] decision: ${shouldBuy ? 'BUY' : 'HOLD'} @ $${price.toFixed(2)}`);
      },
      { 'decision.action': shouldBuy ? 'buy' : 'hold', 'decision.price_usd': price },
    );

    if (!shouldBuy) return;

    // 3. Execute swap (devnet mock: transfer 0.001 SOL to self)
    const sig = await traced(
      'execute_swap',
      async () => {
        const tx = new Transaction().add(
          SystemProgram.transfer({
            fromPubkey: wallet.publicKey,
            toPubkey: wallet.publicKey,
            lamports: Math.floor(0.001 * LAMPORTS_PER_SOL),
          }),
        );
        const signature = await sendAndConfirmTransaction(connection, tx, [wallet]);
        // Correlate this span (and its whole trace) with the on-chain tx
        // so the dashboard's reasoning drill-down can join by signature.
        trace.getActiveSpan()?.setAttribute('solana.tx.signature', signature);
        console.info(`[cycle ${cycle}] swap tx: ${signature}`);
        return signature;
      },
      {
        'solana.action': 'swap',
        'swap.from': 'USDC',
        'swap.to': 'SOL',
        'swap.amount_usd': 10,
        'swap.slippage_bps': 50,
      },
    );

    console.info(`[cycle ${cycle}] done — sig: ${sig}`);
  }, { 'cycle.index': cycle });
}

let cycle = 0;
while (running) {
  cycle += 1;
  try {
    await runTradingCycle(cycle);
  } catch (err) {
    console.error(`[cycle ${cycle}] error:`, err);
  }
  if (running) await new Promise((r) => setTimeout(r, LOOP_INTERVAL_MS));
}

await sdk.shutdown();
console.info('Trader stopped.');
