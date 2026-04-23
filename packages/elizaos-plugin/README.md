# @agentscopehq/elizaos-plugin

Drop-in AgentScope observability for ElizaOS agents. Emits OpenTelemetry reasoning spans to your AgentScope API so every action, decision, and tool call shows up alongside on-chain transactions.

> **Alpha:** the API surface may shift before `1.0`. Pin the exact version in production.

## Install

```bash
pnpm add @agentscopehq/elizaos-plugin@alpha
# or
npm install @agentscopehq/elizaos-plugin@alpha
```

Requires Node 20+ and an existing `@elizaos/core` install.

## Usage

```ts
import { initAgentScope, wrapActions } from '@agentscopehq/elizaos-plugin';

const sdk = initAgentScope({
  apiUrl: process.env.AGENTSCOPE_API_URL,      // https://api.agentscope.dev
  agentToken: process.env.AGENTSCOPE_AGENT_TOKEN, // from dashboard Settings
});

const myPlugin = {
  name: 'my-trading-plugin',
  actions: wrapActions([tradeAction, analyzeAction]),
};

process.on('SIGTERM', () => sdk.shutdown());
```

Get `AGENTSCOPE_AGENT_TOKEN` from the **Settings → Ingest Token** panel of your agent in the AgentScope dashboard.

## What gets traced

Every wrapped action runs inside a root span (`eliza.action.<name>`) whose attributes include:

- `agent.id` — AgentScope agent UUID
- `action.name`, `action.description`
- `runtime.agent_id`, `memory.room_id`, `memory.user_id`
- final `handler.result` plus any thrown error

Spans ship to `/v1/traces` via OTLP/HTTP using the agent token as the bearer.

## Links

- **Dashboard / docs:** https://agentscope.dev
- **Source:** https://github.com/PavloDereniuk/agentscope/tree/main/packages/elizaos-plugin
- **Issues:** https://github.com/PavloDereniuk/agentscope/issues

## License

MIT
