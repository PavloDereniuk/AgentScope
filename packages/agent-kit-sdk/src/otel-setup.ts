import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { NodeSDK } from '@opentelemetry/sdk-node';

export interface AgentScopeConfig {
  /** Base URL of your AgentScope API, e.g. https://api.agentscope.io */
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
 * Fail fast on empty/whitespace tokens. Without this check, OTLP export would
 * silently succeed against the AgentScope API but every trace would be rejected
 * as unauthenticated — a confusing "my traces aren't showing up" class of bug.
 */
function validateAgentToken(agentToken: string): void {
  if (typeof agentToken !== 'string' || agentToken.trim().length === 0) {
    throw new Error('[agentscope] agentToken is required and must be a non-empty string');
  }
}

let _activeSdk: NodeSDK | undefined;

/**
 * Initialises the global OTel NodeSDK and starts exporting traces to AgentScope.
 * Call once at agent startup, before any traced() calls.
 *
 * If called a second time (e.g. in tests or hot-reload), the previous SDK
 * is shut down before the new one starts to prevent resource leaks.
 *
 * Returns the SDK so callers can await sdk.shutdown() on SIGTERM.
 */
export function initAgentScope(config: AgentScopeConfig): NodeSDK {
  validateApiUrl(config.apiUrl);
  validateAgentToken(config.agentToken);
  if (_activeSdk) {
    // Shut down previous SDK; log if it fails so lost spans are visible.
    _activeSdk.shutdown().catch((err) => {
      console.error('[agentscope] SDK shutdown failed during reinit:', err);
    });
  }
  // Auth mechanism: the AgentScope receiver (apps/api/src/otlp/auth.ts) reads
  // `agent.token` from the Resource attributes and looks up the owning agent
  // from the DB. Token is sent over TLS to the configured apiUrl.
  //
  // Caveat: if the host app adds a `ConsoleSpanExporter` or any span processor
  // that logs Resource attributes, the token will appear in those logs. Do not
  // mix this SDK with debug exporters in production.
  _activeSdk = new NodeSDK({
    resource: resourceFromAttributes({ 'agent.token': config.agentToken }),
    traceExporter: new OTLPTraceExporter({
      url: `${config.apiUrl}/v1/traces`,
    }),
  });
  _activeSdk.start();
  return _activeSdk;
}

/**
 * Returns the active SDK instance.
 *
 * @returns The current NodeSDK instance, or `undefined` if `initAgentScope`
 *   has not yet been called in this process.
 */
export function getActiveSdk(): NodeSDK | undefined {
  return _activeSdk;
}
