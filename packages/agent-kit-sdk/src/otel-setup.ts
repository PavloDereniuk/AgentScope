import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { NodeSDK } from '@opentelemetry/sdk-node';

export interface AgentScopeConfig {
  /** Base URL of your AgentScope API, e.g. https://api.agentscope.io */
  apiUrl: string;
  /** Ingest token from the AgentScope dashboard (agents.ingest_token) */
  agentToken: string;
}

let _activeSdk: NodeSDK | undefined;

/**
 * Initialises the global OTel NodeSDK and starts exporting traces to AgentScope.
 * Call once at agent startup, before any traced() calls.
 *
 * Returns the SDK so callers can await sdk.shutdown() on SIGTERM.
 */
export function initAgentScope(config: AgentScopeConfig): NodeSDK {
  _activeSdk = new NodeSDK({
    resource: resourceFromAttributes({ 'agent.token': config.agentToken }),
    traceExporter: new OTLPTraceExporter({
      url: `${config.apiUrl}/v1/traces`,
    }),
  });
  _activeSdk.start();
  return _activeSdk;
}

/** Returns the active SDK instance (undefined before initAgentScope is called). */
export function getActiveSdk(): NodeSDK | undefined {
  return _activeSdk;
}
