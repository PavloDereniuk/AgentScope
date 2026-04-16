/**
 * Minimal ElizaOS interfaces — duck-typed so we don't depend on @elizaos/core at build time.
 * Keep in sync with @elizaos/core v2 Plugin/Action contracts.
 */

export interface IAgentRuntime {
  agentId: string;
  character: { name: string };
}

export interface Memory {
  content: { text: string };
  userId: string;
}

export type State = Record<string, unknown>;

export type HandlerCallback = (response: unknown) => Promise<void>;

export type ActionHandler = (
  runtime: IAgentRuntime,
  message: Memory,
  state?: State,
  options?: Record<string, unknown>,
  callback?: HandlerCallback,
) => Promise<boolean | undefined>;

export interface Action {
  name: string;
  description: string;
  similes: string[];
  examples: unknown[][];
  validate: (runtime: IAgentRuntime, message: Memory) => Promise<boolean>;
  handler: ActionHandler;
}

export interface ElizaPlugin {
  name: string;
  description: string;
  actions?: Action[];
  evaluators?: unknown[];
  providers?: unknown[];
  services?: unknown[];
}
