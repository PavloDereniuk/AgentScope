/**
 * OTLP receiver auth (task 4.3).
 *
 * Agents authenticate to `POST /v1/traces` by putting their
 * per-agent ingest token into the `agent.token` resource attribute
 * of their OpenTelemetry Resource. Their SDK code looks like:
 *
 *     new NodeSDK({
 *       resource: Resource.default().merge(
 *         new Resource({ 'agent.token': 'tok_...' }),
 *       ),
 *       ...
 *     })
 *
 * Every exported batch then carries the token on the first
 * `ResourceSpans.resource.attributes`, so the receiver reads it
 * once per request and resolves it to a real `agents.id` via the
 * unique `ingest_token` index.
 *
 * Why the resource attribute and not the HTTP Authorization header?
 *   - Identity belongs to the telemetry it describes. If a process
 *     pivots to a different agent, it changes its Resource — not
 *     the exporter plumbing.
 *   - The OTel SDK idiom is to attach identity to the Resource;
 *     exporter headers are for transport-level concerns.
 *   - The HTTP header path can be added later without breaking
 *     existing deployments, if we ever need it.
 *
 * Why the *first* ResourceSpans only? One agent = one process =
 * one Resource, so a single export batch should carry exactly one
 * agent's identity. Scanning every ResourceSpans would invite
 * ambiguity we don't want to interpret ("which agent's quota do
 * we charge?").
 */

import { type Database, agents } from '@agentscope/db';
import { eq } from 'drizzle-orm';
import type { ExportTraceServiceRequest } from './schema';

/** Resource attribute key the agent SDK is expected to set. */
export const AGENT_TOKEN_KEY = 'agent.token';

/**
 * Return the non-empty `agent.token` string value from the first
 * ResourceSpans' resource attributes, or `null` if it is absent
 * or not a string. No DB access — this is pure payload inspection.
 */
export function extractAgentToken(body: ExportTraceServiceRequest): string | null {
  const first = body.resourceSpans?.[0];
  const attrs = first?.resource?.attributes;
  if (!attrs) return null;

  for (const kv of attrs) {
    if (kv.key !== AGENT_TOKEN_KEY) continue;
    const raw = kv.value.stringValue;
    if (typeof raw === 'string' && raw.length > 0) return raw;
    return null;
  }
  return null;
}

/** Result of a successful token → agent resolution. */
export interface ResolvedAgent {
  agentId: string;
  userId: string;
}

/**
 * Look up the agent row matching `token` via the unique
 * `ingest_token` index. Returns `null` when no row is found —
 * the caller turns that into 401.
 *
 * We deliberately return the minimal pair the persistence layer
 * (task 4.4) will need: `agents.id` (for the FK) and
 * `agents.user_id` (for future per-tenant checks or quotas).
 */
export async function resolveAgentByToken(
  db: Database,
  token: string,
): Promise<ResolvedAgent | null> {
  const rows = await db
    .select({ id: agents.id, userId: agents.userId })
    .from(agents)
    .where(eq(agents.ingestToken, token))
    .limit(1);

  const row = rows[0];
  if (!row) return null;
  return { agentId: row.id, userId: row.userId };
}
