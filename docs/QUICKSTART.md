# AgentScope Quickstart

Get your Solana AI agent reporting to AgentScope in under 5 minutes.

## 1. Register your agent

Open the AgentScope dashboard, click **New Agent**, fill in the name and wallet address.
Copy the **Ingest Token** from the agent detail page.

## 2. Install the SDK

Choose the package that matches your agent framework:

```bash
# ElizaOS agents
pnpm add @agentscope/elizaos-plugin

# Solana Agent Kit agents (or any framework)
pnpm add @agentscope/agent-kit-sdk
```

## 3. Instrument your agent

### Option A — ElizaOS plugin

```ts
import { initAgentScope, wrapActions } from '@agentscope/elizaos-plugin';

// Boot once at startup (before the agent runtime starts)
const sdk = initAgentScope({
  apiUrl: process.env.AGENTSCOPE_API_URL,   // e.g. https://api.agentscope.io
  agentToken: process.env.AGENTSCOPE_AGENT_TOKEN,
});

// Wrap your plugin's actions — that's it
const myPlugin = {
  name: 'my-trading-plugin',
  description: 'Executes DeFi strategies on Solana',
  actions: wrapActions([tradeAction, analyzeAction, rebalanceAction]),
};

// Graceful shutdown
process.on('SIGTERM', () => sdk.shutdown());
```

Each action execution becomes a span in the AgentScope reasoning tree.
The `message.content.text` is recorded as `reasoning.input`, errors set the span status to ERROR.

### Option B — Solana Agent Kit (or any async code)

```ts
import { initAgentScope, traced } from '@agentscope/agent-kit-sdk';

// Boot once at startup
const sdk = initAgentScope({
  apiUrl: process.env.AGENTSCOPE_API_URL,
  agentToken: process.env.AGENTSCOPE_AGENT_TOKEN,
});

// Wrap every agent action with traced()
async function executeTrade(mint: string, amountSol: number) {
  return traced(
    'execute_trade',              // span name — shows in dashboard
    () => kit.trade(mint, amountSol * 1e9, 'buy'),
    {
      'solana.mint': mint,
      'trade.amount_sol': amountSol,
    },
  );
}

// Nest spans for sub-steps — AgentScope renders the full tree
async function runStrategy(mint: string) {
  return traced('run_strategy', async () => {
    const price = await traced('fetch_price', () => getPrice(mint));
    if (price < 150) {
      const sig = await executeTrade(mint, 1.0);
      console.log('tx:', sig);
    }
  });
}

process.on('SIGTERM', () => sdk.shutdown());
```

## 4. Set environment variables

```bash
AGENTSCOPE_API_URL=https://api.agentscope.io
AGENTSCOPE_AGENT_TOKEN=<paste ingest token here>
```

## 5. See your agent in the dashboard

Start your agent. Within seconds you should see:
- **Transactions** appearing in the timeline (parsed from on-chain activity)
- **Reasoning spans** in the tree view, correlated with each transaction
- **Alerts** firing if the agent breaches configured thresholds (gas, slippage, drawdown)

## How it works

```
Your agent
  └─ traced() / wrapAction()
       └─ OTel span → OTLP/HTTP POST /v1/traces
                            └─ AgentScope API
                                 ├─ validates agent token (ingest_token)
                                 ├─ persists spans to reasoning_logs table
                                 └─ correlates with on-chain transactions
```

The agent token travels as an OTel **Resource attribute** (`agent.token`), not an HTTP header —
this follows the OTel identity-on-Resource idiom and survives proxy hops without custom header forwarding.
