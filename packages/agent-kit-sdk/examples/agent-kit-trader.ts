/**
 * Minimal example: Solana Agent Kit + AgentScope observability.
 *
 * Run with:
 *   AGENTSCOPE_API_URL=https://api.agentscope.io \
 *   AGENTSCOPE_AGENT_TOKEN=<your-token> \
 *   npx tsx examples/agent-kit-trader.ts
 */

import { initAgentScope, traced } from '../src/index.js';

// 1. Boot AgentScope — must happen before any traced() calls.
const sdk = initAgentScope({
  apiUrl: process.env.AGENTSCOPE_API_URL ?? 'http://localhost:3000',
  agentToken: process.env.AGENTSCOPE_AGENT_TOKEN ?? 'change-me',
});

// 2. Example: wrap each agent action in a traced() span.
async function analyzeMarket(mint: string): Promise<number> {
  return traced(
    'analyze_market',
    async () => {
      // Replace with real Solana Agent Kit logic, e.g.:
      //   const price = await kit.getTokenData(mint);
      console.info(`[analyze] checking price for ${mint}`);
      return 145.3; // mock price in USDC
    },
    { 'solana.mint': mint },
  );
}

async function executeTrade(mint: string, amountSol: number): Promise<string> {
  return traced(
    'execute_trade',
    async () => {
      // Replace with:
      //   const sig = await kit.trade(new PublicKey(mint), amountSol * 1e9, 'buy');
      const sig = '5mockSignaturexxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
      console.info(`[trade] bought ${amountSol} SOL of ${mint}, sig=${sig}`);
      return sig;
    },
    { 'solana.mint': mint, 'trade.amount_sol': amountSol },
  );
}

// 3. Run the agent loop (single cycle for the example).
const WSOL = 'So11111111111111111111111111111111111111112';
const price = await analyzeMarket(WSOL);
if (price < 150) {
  const signature = await executeTrade(WSOL, 1.0);
  console.info(`Trade complete: ${signature}`);
}

// 4. Flush spans before exit.
await sdk.shutdown();
console.info('Done — spans exported to AgentScope.');
