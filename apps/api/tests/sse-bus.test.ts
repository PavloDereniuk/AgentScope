/**
 * Unit tests for the in-memory SSE bus (task 3.4).
 *
 * Everything runs synchronously via EventEmitter, so no timers or
 * async plumbing are needed — each publish is fully delivered before
 * the next line of the test.
 */

import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { type BusEvent, createSseBus } from '../src/lib/sse-bus';

const silentLogger = pino({ level: 'silent' });

function txEvent(agentId: string, signature = 'sig-a'): BusEvent {
  return { type: 'tx.new', agentId, signature, at: '2026-04-08T12:00:00.000Z' };
}

function alertEvent(agentId: string, alertId = 'al-1'): BusEvent {
  return {
    type: 'alert.new',
    agentId,
    alertId,
    severity: 'warning',
    at: '2026-04-08T12:00:00.000Z',
  };
}

describe('sse bus', () => {
  it('delivers a published event to a subscribed handler', () => {
    const bus = createSseBus();
    const handler = vi.fn();

    bus.subscribe('agent-1', handler);
    bus.publish(txEvent('agent-1'));

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(txEvent('agent-1'));
  });

  it('only notifies subscribers of the matching agentId', () => {
    const bus = createSseBus();
    const aliceHandler = vi.fn();
    const bobHandler = vi.fn();

    bus.subscribe('alice', aliceHandler);
    bus.subscribe('bob', bobHandler);
    bus.publish(txEvent('alice', 'sig-for-alice'));

    expect(aliceHandler).toHaveBeenCalledTimes(1);
    expect(aliceHandler).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'tx.new', agentId: 'alice', signature: 'sig-for-alice' }),
    );
    expect(bobHandler).not.toHaveBeenCalled();
  });

  it('fans out to every subscriber of the same agent', () => {
    const bus = createSseBus();
    const handler1 = vi.fn();
    const handler2 = vi.fn();
    const handler3 = vi.fn();

    bus.subscribe('agent-1', handler1);
    bus.subscribe('agent-1', handler2);
    bus.subscribe('agent-1', handler3);
    bus.publish(alertEvent('agent-1', 'al-99'));

    expect(handler1).toHaveBeenCalledTimes(1);
    expect(handler2).toHaveBeenCalledTimes(1);
    expect(handler3).toHaveBeenCalledTimes(1);
  });

  it('unsubscribe stops subsequent deliveries without affecting others', () => {
    const bus = createSseBus();
    const stays = vi.fn();
    const leaves = vi.fn();

    bus.subscribe('agent-1', stays);
    const unsubscribe = bus.subscribe('agent-1', leaves);

    bus.publish(txEvent('agent-1', 'sig-1'));
    unsubscribe();
    bus.publish(txEvent('agent-1', 'sig-2'));

    expect(stays).toHaveBeenCalledTimes(2);
    expect(leaves).toHaveBeenCalledTimes(1);
    expect(leaves).toHaveBeenCalledWith(expect.objectContaining({ signature: 'sig-1' }));
  });

  it('a throwing handler does not prevent other handlers from running', () => {
    const logs = vi.fn();
    const logger = pino({ level: 'error' }, { write: logs });
    const bus = createSseBus(logger);
    const survivor = vi.fn();

    bus.subscribe('agent-1', () => {
      throw new Error('handler blew up');
    });
    bus.subscribe('agent-1', survivor);

    bus.publish(txEvent('agent-1'));

    expect(survivor).toHaveBeenCalledTimes(1);
    // The logger received an error line about the crashed handler.
    expect(logs).toHaveBeenCalled();
    const lastLog = String(logs.mock.calls[0]?.[0] ?? '');
    expect(lastLog).toContain('sse bus handler threw');
  });

  it('publishing with no subscribers is a no-op', () => {
    const bus = createSseBus(silentLogger);
    expect(() => bus.publish(txEvent('nobody-home'))).not.toThrow();
  });

  it('subscriberCount reflects active listeners', () => {
    const bus = createSseBus();

    expect(bus.subscriberCount('agent-1')).toBe(0);
    const u1 = bus.subscribe('agent-1', vi.fn());
    const u2 = bus.subscribe('agent-1', vi.fn());
    expect(bus.subscriberCount('agent-1')).toBe(2);
    expect(bus.subscriberCount('agent-2')).toBe(0);

    u1();
    expect(bus.subscriberCount('agent-1')).toBe(1);
    u2();
    expect(bus.subscriberCount('agent-1')).toBe(0);
  });
});
