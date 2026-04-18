/**
 * In-process pub/sub for real-time dashboard updates (task 3.4).
 *
 * The ingestion worker writes to Postgres, the detector raises alerts,
 * and both call `bus.publish(...)` so any dashboard SSE connection
 * listening for that agent gets the event pushed immediately — without
 * polling.
 *
 * MVP scope: single Railway api instance, everything stays in memory.
 * Scaling to multiple instances is explicitly post-MVP (see PLAN.md):
 * we'd swap the internal `EventEmitter` for Redis pub/sub and keep the
 * same public `SseBus` interface. Consumers should only rely on the
 * interface exported below, not on the `node:events` import.
 */

import { EventEmitter } from 'node:events';
import { z } from 'zod';
import type { Logger } from '../logger';

/**
 * Zod schema for validating incoming /internal/publish payloads.
 * Every string field is length-capped so a misbehaving (or malicious)
 * publisher cannot push arbitrarily large frames through every SSE fan-out.
 */
export const busEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('tx.new'),
    agentId: z.string().min(1).max(64),
    signature: z.string().min(1).max(128),
    at: z.string().min(1).max(64),
  }),
  z.object({
    type: z.literal('alert.new'),
    agentId: z.string().min(1).max(64),
    alertId: z.string().min(1).max(64),
    severity: z.enum(['info', 'warning', 'critical']),
    at: z.string().min(1).max(64),
  }),
]);

/**
 * Discriminated union of every event the dashboard cares about. Keep
 * payloads small — SSE is best-effort, clients refetch details via REST
 * when they need the full picture.
 */
export type BusEvent = z.infer<typeof busEventSchema>;

export type BusEventType = BusEvent['type'];

export type BusHandler = (event: BusEvent) => void;

export interface SseBus {
  /**
   * Subscribe to every event for a single agent. Returns an
   * `unsubscribe()` function — call it from the SSE route's close
   * handler to drop the listener and free memory.
   */
  subscribe(agentId: string, handler: BusHandler): () => void;

  /**
   * Publish an event. Fans out synchronously to every subscriber of
   * `event.agentId`. If any handler throws, it is logged (when a
   * logger was provided) and the remaining handlers still run.
   */
  publish(event: BusEvent): void;

  /** Active listener count for a given agent. Used by tests and metrics. */
  subscriberCount(agentId: string): number;
}

/**
 * Build a new bus. The optional logger is used only to report handler
 * crashes; publish/subscribe are silent on the happy path.
 */
export function createSseBus(logger?: Logger): SseBus {
  const emitter = new EventEmitter();
  // Cap at a large-but-finite number: high enough that a power user with
  // many open tabs won't trip the warning, low enough that a genuine leak
  // (e.g. handlers that forget to unsubscribe on abort) will surface in logs.
  // Setting 0 disables the check entirely and hides real bugs.
  emitter.setMaxListeners(1000);

  return {
    subscribe(agentId, handler) {
      const wrapped = (event: BusEvent) => {
        try {
          handler(event);
        } catch (err) {
          logger?.error({ err, agentId, eventType: event.type }, 'sse bus handler threw');
        }
      };
      emitter.on(agentId, wrapped);
      return () => {
        emitter.off(agentId, wrapped);
      };
    },

    publish(event) {
      emitter.emit(event.agentId, event);
    },

    subscriberCount(agentId) {
      return emitter.listenerCount(agentId);
    },
  };
}
