/**
 * @agentscope/agent-kit-sdk
 *
 * Add AgentScope observability to any Solana agent in two lines:
 *
 *   import { initAgentScope, traced } from '@agentscope/agent-kit-sdk';
 *
 *   initAgentScope({
 *     apiUrl: process.env.AGENTSCOPE_API_URL,
 *     agentToken: process.env.AGENTSCOPE_AGENT_TOKEN,
 *   });
 *
 *   // Wrap any async action:
 *   const sig = await traced('swap', () => kit.trade(mint, amount, 'buy'), {
 *     'solana.mint': mint,
 *     'trade.amount_sol': amount,
 *   });
 */

export { initAgentScope, getActiveSdk } from './otel-setup.js';
export type { AgentScopeConfig } from './otel-setup.js';

export { traced } from './trace-decorator.js';
export type { SpanAttributes } from './trace-decorator.js';
