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
 *
 * `userId` is required on every event. It powers `subscribeUser` so a
 * single dashboard stream can receive updates across every agent the
 * user owns without iterating per-agent subscriptions — critical for
 * the Overview page where the set of agents can change mid-session.
 */
export const busEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('tx.new'),
    agentId: z.string().min(1).max(64),
    userId: z.string().min(1).max(64),
    signature: z.string().min(1).max(128),
    at: z.string().min(1).max(64),
  }),
  z.object({
    type: z.literal('alert.new'),
    agentId: z.string().min(1).max(64),
    userId: z.string().min(1).max(64),
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
   * Subscribe to every event for any agent owned by `userId`. Fan-out
   * uses the `userId` field on each published event, so new agents
   * created AFTER the subscription was opened are picked up without
   * the subscriber having to reconnect — as soon as the next event
   * carries that userId, it reaches the handler.
   */
  subscribeUser(userId: string, handler: BusHandler): () => void;

  /**
   * Publish an event. Fans out synchronously to every subscriber of
   * `event.agentId` AND every subscriber of `event.userId`. If any
   * handler throws, it is logged (when a logger was provided) and the
   * remaining handlers still run.
   */
  publish(event: BusEvent): void;

  /** Active listener count for a given agent. Used by tests and metrics. */
  subscriberCount(agentId: string): number;

  /** Active listener count for a given user. Used by tests and metrics. */
  userSubscriberCount(userId: string): number;
}

/**
 * Build a new bus. The optional logger is used only to report handler
 * crashes; publish/subscribe are silent on the happy path.
 */
/**
 * Internal-only prefix for per-user channels. We namespace the event
 * emitter keys so an attacker cannot craft an `agentId` that collides
 * with another user's subscription channel. Agent IDs are UUIDs, which
 * cannot start with `user:` — but explicit is better than implicit.
 */
const USER_CHANNEL_PREFIX = 'user:';

export function createSseBus(logger?: Logger): SseBus {
  const emitter = new EventEmitter();
  // Cap at a large-but-finite number: high enough that a power user with
  // many open tabs won't trip the warning, low enough that a genuine leak
  // (e.g. handlers that forget to unsubscribe on abort) will surface in logs.
  // Setting 0 disables the check entirely and hides real bugs.
  emitter.setMaxListeners(1000);

  function wrap(
    handler: BusHandler,
    scope: { kind: 'agent' | 'user'; id: string },
  ): (event: BusEvent) => void {
    return (event: BusEvent) => {
      try {
        handler(event);
      } catch (err) {
        logger?.error(
          { err, scope: scope.kind, id: scope.id, eventType: event.type },
          'sse bus handler threw',
        );
      }
    };
  }

  return {
    subscribe(agentId, handler) {
      const wrapped = wrap(handler, { kind: 'agent', id: agentId });
      emitter.on(agentId, wrapped);
      return () => {
        emitter.off(agentId, wrapped);
      };
    },

    subscribeUser(userId, handler) {
      const channel = `${USER_CHANNEL_PREFIX}${userId}`;
      const wrapped = wrap(handler, { kind: 'user', id: userId });
      emitter.on(channel, wrapped);
      return () => {
        emitter.off(channel, wrapped);
      };
    },

    publish(event) {
      // Fan to both channels. Synchronous — a handler crash on the
      // agent side will not drop user-side delivery because `wrap`
      // catches per-handler and `emit` keeps iterating.
      emitter.emit(event.agentId, event);
      emitter.emit(`${USER_CHANNEL_PREFIX}${event.userId}`, event);
    },

    subscriberCount(agentId) {
      return emitter.listenerCount(agentId);
    },

    userSubscriberCount(userId) {
      return emitter.listenerCount(`${USER_CHANNEL_PREFIX}${userId}`);
    },
  };
}
