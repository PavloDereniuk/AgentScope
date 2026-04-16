/**
 * @agentscope/elizaos-plugin
 *
 * Auto-instrument ElizaOS action handlers with OpenTelemetry traces
 * and ship them to the AgentScope observability platform.
 *
 * Usage:
 *   import { initAgentScope, wrapActions } from '@agentscope/elizaos-plugin';
 *
 *   const sdk = initAgentScope({
 *     apiUrl: process.env.AGENTSCOPE_API_URL,
 *     agentToken: process.env.AGENTSCOPE_AGENT_TOKEN,
 *   });
 *
 *   const myPlugin = {
 *     name: 'my-trading-plugin',
 *     actions: wrapActions([tradeAction, analyzeAction]),
 *   };
 *
 *   process.on('SIGTERM', () => sdk.shutdown());
 */

export { initAgentScope, createSdk } from './otel-exporter.js';
export type { AgentScopeConfig } from './otel-exporter.js';

export { wrapAction, wrapActions } from './action-hooks.js';

export type {
  ElizaPlugin,
  Action,
  ActionHandler,
  IAgentRuntime,
  Memory,
  State,
  HandlerCallback,
} from './types.js';
