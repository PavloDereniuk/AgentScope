/**
 * AgentScope task 10.7a — Live Solana Agent Kit-style agent.
 *
 * Persona "PriceWatcher": rule-based trader. Polls SOL/USD from CoinGecko
 * every cycle, alternates BUY (SOL → USDC) and SELL (USDC → SOL) dust swaps
 * via the Jupiter `lite-api` swap endpoint, and reports every decision step
 * as an OTel span to AgentScope through `@agentscopehq/agent-kit-sdk`.
 *
 * Goal: verify three hooks land in the AgentScope dashboard end-to-end:
 *   (a) reasoning spans (analyze_market → make_decision → execute_swap)
 *   (b) parsed Jupiter v6 transactions (ingestion → parser)
 *   (c) at least one detector-triggered alert
 *
 * Why we call Jupiter directly instead of `solana-agent-kit`:
 *   solana-agent-kit@1.4.9 hard-codes `https://quote-api.jup.ag/v6/...` which
 *   has been retired by Jupiter (DNS no longer resolves). Jupiter v6 paths
 *   live on `lite-api.jup.ag/swap/v1/...` for free public usage. The shape
 *   of the resulting on-chain swap is identical from the parser's point of
 *   view, so 10.7a's validation goal is unaffected.
 */

// Env vars are loaded by node's --env-file flag (see scripts/package.json).
// We avoid `dotenv` to keep this script free of extra deps.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { initAgentScope, trace, traced } from '@agentscopehq/agent-kit-sdk';
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  VersionedTransaction,
} from '@solana/web3.js';

const SOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');
const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const USDC_DECIMALS = 6;

const JUP_QUOTE_URL = 'https://lite-api.jup.ag/swap/v1/quote';
const JUP_SWAP_URL = 'https://lite-api.jup.ag/swap/v1/swap';

// ───────────────────────────── Config ─────────────────────────────

const RPC_URL = required('SOLANA_RPC_URL');
const API_URL = required('AGENTSCOPE_API_URL');
const AGENT_TOKEN = required('AGENTSCOPE_AGENT_TOKEN');

const AGENT_NAME = process.env.AGENT_NAME ?? 'PriceWatcher';
const SWAP_AMOUNT_SOL = Number(process.env.SWAP_AMOUNT_SOL ?? '0.001');
const LOOP_INTERVAL_MS = Number(process.env.LOOP_INTERVAL_MS ?? '120000');
const SLIPPAGE_BPS = Number(process.env.SLIPPAGE_BPS ?? '100');

if (SWAP_AMOUNT_SOL > 0.005) {
  console.error(`Refusing to start: SWAP_AMOUNT_SOL=${SWAP_AMOUNT_SOL} exceeds dust cap (0.005 SOL).`);
  process.exit(1);
}

function required(name: string): string {
  const v = process.env[name];
  if (!v || v.trim().length === 0) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
  return v;
}

// ─────────────────────── Wallet / SDK init ────────────────────────

const keypair = loadKeypair();
console.info(`[${AGENT_NAME}] wallet: ${keypair.publicKey.toBase58()}`);

const connection = new Connection(RPC_URL, 'confirmed');

const balance = await connection.getBalance(keypair.publicKey);
const solBalance = balance / LAMPORTS_PER_SOL;
console.info(`[${AGENT_NAME}] balance: ${solBalance.toFixed(6)} SOL`);
if (solBalance < 0.01) {
  console.error('Insufficient SOL: need at least 0.01 to cover dust swaps + fees.');
  process.exit(1);
}

const sdk = initAgentScope({ apiUrl: API_URL, agentToken: AGENT_TOKEN });
console.info(`[${AGENT_NAME}] AgentScope -> ${API_URL}`);

let running = true;
let cycle = 0;
process.on('SIGINT', () => {
  running = false;
  console.info(`[${AGENT_NAME}] SIGINT received, finishing current cycle...`);
});
process.on('SIGTERM', () => {
  running = false;
});

// ─────────────────────── Trading loop ─────────────────────────────

while (running) {
  cycle += 1;
  try {
    await runCycle(cycle);
  } catch (err) {
    console.error(`[${AGENT_NAME}] cycle ${cycle} failed:`, err);
  }
  if (running) await sleep(LOOP_INTERVAL_MS);
}

try {
  await sdk.shutdown();
  console.info(`[${AGENT_NAME}] stopped cleanly after ${cycle} cycle(s).`);
} catch (err) {
  console.error(`[${AGENT_NAME}] shutdown error:`, err);
  process.exit(1);
}

// ────────────────────────── Helpers ───────────────────────────────

async function runCycle(idx: number): Promise<void> {
  await traced(
    'trading_cycle',
    async () => {
      const price = await traced(
        'analyze_market',
        async () => fetchSolPriceUsd(),
        {
          'solana.mint': SOL_MINT.toBase58(),
          'reasoning.model': 'rule-based',
          'reasoning.source': 'coingecko',
        },
      );
      console.info(`[cycle ${idx}] SOL/USD = $${price.toFixed(2)}`);

      // Persona rule: alternate sides every cycle to exercise both swap legs.
      // Start with BUY so the wallet acquires USDC before its first SELL —
      // otherwise cycle 1 would try to sell USDC we don't yet have, and the
      // Jupiter route fails with "no source balance" (custom error 0x1789).
      const side: 'buy' | 'sell' = idx % 2 === 1 ? 'buy' : 'sell';

      await traced(
        'make_decision',
        async () => {
          console.info(`[cycle ${idx}] decision: ${side.toUpperCase()} @ $${price.toFixed(2)}`);
          return side;
        },
        {
          'decision.action': side,
          'decision.price_usd': price,
          'decision.amount_sol': SWAP_AMOUNT_SOL,
        },
      );

      const sig = await traced(
        'execute_swap',
        async () => {
          let signature: string;
          if (side === 'buy') {
            // SOL → USDC. amount in lamports.
            const lamports = Math.floor(SWAP_AMOUNT_SOL * LAMPORTS_PER_SOL);
            signature = await jupiterSwap(SOL_MINT, USDC_MINT, lamports, SLIPPAGE_BPS);
          } else {
            // USDC → SOL. amount in micro-USDC. Approximate previous buy at
            // 95% of SOL value to leave room for slippage + fees. If we're
            // out of USDC, Jupiter returns an error — itself a useful signal.
            const usdcUnits = Math.max(
              50_000, // 0.05 USDC floor
              Math.floor(SWAP_AMOUNT_SOL * price * 0.95 * 10 ** USDC_DECIMALS),
            );
            signature = await jupiterSwap(USDC_MINT, SOL_MINT, usdcUnits, SLIPPAGE_BPS);
          }
          trace.getActiveSpan()?.setAttribute('solana.tx.signature', signature);
          console.info(`[cycle ${idx}] tx: https://solscan.io/tx/${signature}`);
          return signature;
        },
        {
          'solana.action': 'swap',
          'swap.protocol': 'jupiter',
          'swap.side': side,
          'swap.input_mint': side === 'buy' ? SOL_MINT.toBase58() : USDC_MINT.toBase58(),
          'swap.output_mint': side === 'buy' ? USDC_MINT.toBase58() : SOL_MINT.toBase58(),
          'swap.amount_sol': SWAP_AMOUNT_SOL,
          'swap.slippage_bps': SLIPPAGE_BPS,
        },
      );

      console.info(`[cycle ${idx}] done — sig: ${sig}`);
    },
    { 'cycle.index': idx, 'agent.persona': AGENT_NAME },
  );
}

async function fetchSolPriceUsd(): Promise<number> {
  const res = await fetch(
    'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd',
    { signal: AbortSignal.timeout(5000) },
  );
  if (!res.ok) throw new Error(`CoinGecko ${res.status}`);
  const json = (await res.json()) as { solana?: { usd?: number } };
  const price = json.solana?.usd;
  if (typeof price !== 'number') throw new Error('CoinGecko: missing solana.usd');
  return price;
}

async function jupiterSwap(
  inputMint: PublicKey,
  outputMint: PublicKey,
  amount: number,
  slippageBps: number,
): Promise<string> {
  const quoteUrl = `${JUP_QUOTE_URL}?inputMint=${inputMint.toBase58()}&outputMint=${outputMint.toBase58()}&amount=${amount}&slippageBps=${slippageBps}`;
  const quoteRes = await fetch(quoteUrl, { signal: AbortSignal.timeout(15_000) });
  if (!quoteRes.ok) {
    throw new Error(`Jupiter quote ${quoteRes.status}: ${await quoteRes.text().catch(() => '')}`);
  }
  const quote = (await quoteRes.json()) as Record<string, unknown>;

  const swapRes = await fetch(JUP_SWAP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: keypair.publicKey.toBase58(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!swapRes.ok) {
    throw new Error(`Jupiter swap ${swapRes.status}: ${await swapRes.text().catch(() => '')}`);
  }
  const { swapTransaction } = (await swapRes.json()) as { swapTransaction: string };

  const tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, 'base64'));
  tx.sign([keypair]);
  const sig = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    maxRetries: 3,
  });
  await connection.confirmTransaction(sig, 'confirmed');
  return sig;
}

function loadKeypair(): Keypair {
  const path = process.env.SOLANA_KEYPAIR_PATH;
  if (!path || path.trim().length === 0) {
    throw new Error('Set SOLANA_KEYPAIR_PATH (path to JSON-array keypair file)');
  }
  const raw = JSON.parse(readFileSync(resolve(path), 'utf-8')) as number[];
  if (!Array.isArray(raw) || raw.length !== 64) {
    throw new Error(`Invalid keypair file at ${path}: expected number[64]`);
  }
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
