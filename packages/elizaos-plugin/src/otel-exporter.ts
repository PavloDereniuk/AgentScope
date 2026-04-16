import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { NodeSDK } from '@opentelemetry/sdk-node';

export interface AgentScopeConfig {
  /** Base URL of your AgentScope API, e.g. https://api.agentscope.io */
  apiUrl: string;
  /** Ingest token from the AgentScope dashboard (agents.ingest_token) */
  agentToken: string;
}

/**
 * Creates (but does not start) a configured NodeSDK that exports OTLP traces
 * to AgentScope. The agent identity is passed via Resource attribute `agent.token`
 * — the AgentScope receiver extracts it from resourceSpans[0].resource.attributes.
 */
export function createSdk(config: AgentScopeConfig): NodeSDK {
  return new NodeSDK({
    resource: resourceFromAttributes({ 'agent.token': config.agentToken }),
    traceExporter: new OTLPTraceExporter({
      url: `${config.apiUrl}/v1/traces`,
    }),
  });
}

/**
 * Convenience: creates AND starts the SDK. Returns the SDK so callers can
 * call sdk.shutdown() on process exit.
 */
export function initAgentScope(config: AgentScopeConfig): NodeSDK {
  const sdk = createSdk(config);
  sdk.start();
  return sdk;
}
