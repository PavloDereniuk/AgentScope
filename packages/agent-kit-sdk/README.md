# @agentscopehq/agent-kit-sdk

AgentScope observability wrapper for [Solana Agent Kit](https://github.com/sendaifun/solana-agent-kit). Hooks every tool call into OpenTelemetry spans the AgentScope API ingests in real time.

> **Alpha:** the API surface may shift before `1.0`. Pin the exact version in production.

## Install

```bash
pnpm add @agentscopehq/agent-kit-sdk@alpha
# or
npm install @agentscopehq/agent-kit-sdk@alpha
```

Requires Node 20+. Works with any SolanaAgentKit instance; `solana-agent-kit` is an optional peer.

## Usage

```ts
import { initAgentScope, traced } from '@agentscopehq/agent-kit-sdk';

initAgentScope({
  apiUrl: process.env.AGENTSCOPE_API_URL,        // https://api.agentscopehq.dev
  agentToken: process.env.AGENTSCOPE_AGENT_TOKEN, // from dashboard Settings
});

// Wrap any async action:
const sig = await traced('swap', () => kit.trade(mint, amount, 'buy'), {
  'solana.mint': mint,
  'trade.amount_sol': amount,
});
```

Get `AGENTSCOPE_AGENT_TOKEN` from the **Settings → Ingest Token** panel of your agent in the AgentScope dashboard.

## Enriching spans post hoc

Re-export of `trace` from `@opentelemetry/api` lets you attach on-chain signatures once the tx confirms — no extra dep needed:

```ts
import { trace } from '@agentscopehq/agent-kit-sdk';

const sig = await traced('swap', async () => {
  const result = await kit.trade(mint, amount, 'buy');
  trace.getActiveSpan()?.setAttribute('solana.signature', result.signature);
  return result;
});
```

## Links

- **Dashboard / docs:** https://agentscopehq.dev

## License

MIT
