import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { NodeSDK } from '@opentelemetry/sdk-node';

export interface AgentScopeConfig {
  /** Base URL of your AgentScope API, e.g. https://api.agentscopehq.dev */
  apiUrl: string;
  /** Ingest token from the AgentScope dashboard (agents.ingest_token) */
  agentToken: string;
}

/** Validate apiUrl to prevent SSRF via non-HTTP protocols. */
function validateApiUrl(apiUrl: string): void {
  let url: URL;
  try {
    url = new URL(apiUrl);
  } catch {
    throw new Error(`[agentscope] Invalid apiUrl "${apiUrl}": must be a valid URL`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(
      `[agentscope] Invalid apiUrl: protocol must be http or https, got ${url.protocol}`,
    );
  }
}

/**
 * Fail fast on empty/whitespace tokens. Without this, the plugin would emit
 * OTLP traces with an empty agent.token Resource attribute and the AgentScope
 * receiver would silently drop every span.
 */
function validateAgentToken(agentToken: string): void {
  if (typeof agentToken !== 'string' || agentToken.trim().length === 0) {
    throw new Error('[agentscope] agentToken is required and must be a non-empty string');
  }
}

/**
 * Creates (but does not start) a configured NodeSDK that exports OTLP traces
 * to AgentScope. The agent identity is passed via Resource attribute `agent.token`
 * — the AgentScope receiver extracts it from resourceSpans[0].resource.attributes.
 */
export function createSdk(config: AgentScopeConfig): NodeSDK {
  validateApiUrl(config.apiUrl);
  validateAgentToken(config.agentToken);
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
