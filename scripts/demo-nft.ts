/**
 * 9.5 — Demo NFT-bot: Tensor-style NFT sniper (mock mode).
 *
 * Simulates an NFT sniping agent: scans floor prices, snipes undervalued
 * listings. NFT purchases are mocked with 0.001 SOL transfers to self.
 *
 * Run: pnpm --filter @agentscope/scripts demo-nft
 *
 * Env vars:
 *   SOLANA_RPC_URL            (default: mainnet-beta public RPC)
 *   AGENTSCOPE_API_URL
 *   AGENTSCOPE_AGENT_TOKEN_NFT
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

const RPC_URL = process.env['SOLANA_RPC_URL'] ?? 'https://api.mainnet-beta.solana.com';
const API_URL = process.env['AGENTSCOPE_API_URL'] ?? 'http://localhost:3000';
const AGENT_TOKEN = process.env['AGENTSCOPE_AGENT_TOKEN_NFT'] ?? '';
const LOOP_INTERVAL_MS = Number(process.env['DEMO_INTERVAL_MS'] ?? '60000');

if (!AGENT_TOKEN) {
  console.error('AGENTSCOPE_AGENT_TOKEN_NFT is required');
  process.exit(1);
}

const MIN_SOL_BALANCE = 0.005;

const connection = new Connection(RPC_URL, 'confirmed');
const secretKey = JSON.parse(readFileSync('../wallets/nft-bot.keypair.json', 'utf-8')) as number[];
const wallet = Keypair.fromSecretKey(Uint8Array.from(secretKey));

console.info(`NFT-bot wallet: ${wallet.publicKey.toBase58()}`);

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

const COLLECTIONS = ['SMB', 'MadLads', 'Claynosaurz', 'DeGods'];

async function runNftCycle(cycle: number): Promise<void> {
  await traced('nft_cycle', async () => {
    const collection = COLLECTIONS[cycle % COLLECTIONS.length] ?? 'SMB';

    // 1. Scan floor
    const floor = await traced(
      'scan_floor',
      async () => {
        const mockFloor = 2 + Math.random() * 8; // 2–10 SOL
        console.info(`[cycle ${cycle}] ${collection} floor: ${mockFloor.toFixed(2)} SOL`);
        return mockFloor;
      },
      { 'nft.collection': collection, 'nft.marketplace': 'tensor' },
    );

    // 2. Check if undervalued (vs simple moving average mock)
    const sma = floor * (1 + (Math.random() - 0.3) * 0.2);
    const undervalued = floor < sma * 0.95;

    await traced('evaluate_listing', async () => {
      console.info(`[cycle ${cycle}] ${collection} SMA: ${sma.toFixed(2)} SOL — ${undervalued ? 'SNIPE' : 'SKIP'}`);
    }, { 'nft.floor_sol': floor, 'nft.sma_sol': sma, 'nft.undervalued': undervalued });

    if (!undervalued) return;

    // 3. Snipe (devnet mock)
    const sig = await traced(
      'snipe_nft',
      async () => {
        const tx = new Transaction().add(
          SystemProgram.transfer({
            fromPubkey: wallet.publicKey,
            toPubkey: wallet.publicKey,
            lamports: Math.floor(0.001 * LAMPORTS_PER_SOL),
          }),
        );
        const signature = await sendAndConfirmTransaction(connection, tx, [wallet]);
        console.info(`[cycle ${cycle}] sniped ${collection} — tx: ${signature}`);
        return signature;
      },
      { 'nft.collection': collection, 'nft.price_sol': floor, 'nft.action': 'buy' },
    );

    console.info(`[cycle ${cycle}] done — sig: ${sig}`);
  }, { 'cycle.index': cycle });
}

let cycle = 0;
while (running) {
  cycle += 1;
  try {
    await runNftCycle(cycle);
  } catch (err) {
    console.error(`[cycle ${cycle}] error:`, err);
  }
  if (running) await new Promise((r) => setTimeout(r, LOOP_INTERVAL_MS));
}

await sdk.shutdown();
console.info('NFT-bot stopped.');
