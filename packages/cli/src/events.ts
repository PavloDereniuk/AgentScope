/**
 * Wire format for events the CLI consumes from
 * `GET /v1/agents/:id/stream`.
 *
 * Shape mirrors `apps/api/src/lib/sse-bus.ts:busEventSchema` plus the
 * initial `{ type: 'connected' }` handshake. We hand-define the shape
 * here rather than importing from the API package so the published CLI
 * tarball doesn't drag in Hono / Drizzle / pg as transitive deps.
 */

export interface ConnectedEvent {
  type: 'connected';
}

export interface TxNewEvent {
  type: 'tx.new';
  agentId: string;
  userId: string;
  signature: string;
  at: string;
}

export interface AlertNewEvent {
  type: 'alert.new';
  agentId: string;
  userId: string;
  alertId: string;
  severity: 'info' | 'warning' | 'critical';
  at: string;
}

export type BusEvent = ConnectedEvent | TxNewEvent | AlertNewEvent;

/**
 * Narrow an unknown JSON payload into a known event shape. Returns null
 * for anything we don't recognize so the renderer can decide whether to
 * print a debug line or silently drop it. We deliberately accept extra
 * fields (forward-compat: the server may add `txId`, `ruleName`, etc.
 * later without breaking older CLIs).
 */
export function parseEvent(raw: unknown): BusEvent | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const type = obj.type;
  if (type === 'connected') {
    return { type: 'connected' };
  }
  if (type === 'tx.new') {
    if (
      typeof obj.agentId === 'string' &&
      typeof obj.userId === 'string' &&
      typeof obj.signature === 'string' &&
      typeof obj.at === 'string'
    ) {
      return {
        type: 'tx.new',
        agentId: obj.agentId,
        userId: obj.userId,
        signature: obj.signature,
        at: obj.at,
      };
    }
    return null;
  }
  if (type === 'alert.new') {
    const sev = obj.severity;
    if (
      typeof obj.agentId === 'string' &&
      typeof obj.userId === 'string' &&
      typeof obj.alertId === 'string' &&
      (sev === 'info' || sev === 'warning' || sev === 'critical') &&
      typeof obj.at === 'string'
    ) {
      return {
        type: 'alert.new',
        agentId: obj.agentId,
        userId: obj.userId,
        alertId: obj.alertId,
        severity: sev,
        at: obj.at,
      };
    }
    return null;
  }
  return null;
}
