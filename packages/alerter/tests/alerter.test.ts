/**
 * Tests for alerter package (tasks 5.11-5.13).
 *
 * Tests Telegram message formatting, mock delivery, and the deliver()
 * strategy router.
 */

import { describe, expect, it, vi } from 'vitest';
import { deliver } from '../src/deliver';
import { formatTelegramMessage } from '../src/telegram';
import type { AlertMessage, ChannelSender } from '../src/types';

const sampleAlert: AlertMessage = {
  id: 'alert-1',
  agentId: 'agent-1',
  agentName: 'Trading Bot',
  ruleName: 'slippage_spike',
  severity: 'warning',
  payload: { actualPct: 12, thresholdPct: 5, signature: '5VERv8NMvzbJMEkV8xnr' },
  triggeredAt: '2026-04-09T12:00:00Z',
};

describe('formatTelegramMessage', () => {
  it('formats an alert with severity icon and payload fields', () => {
    const text = formatTelegramMessage(sampleAlert);
    expect(text).toContain('⚠️');
    expect(text).toContain('SLIPPAGE SPIKE');
    expect(text).toContain('Trading Bot');
    expect(text).toContain('actualPct');
    expect(text).toContain('12');
  });

  it('uses critical icon for critical severity', () => {
    const critical = { ...sampleAlert, severity: 'critical' as const };
    const text = formatTelegramMessage(critical);
    expect(text).toContain('🚨');
  });
});

describe('deliver', () => {
  it('routes to telegram sender when channel is telegram', async () => {
    const mockSender: ChannelSender = {
      send: vi.fn().mockResolvedValue({ success: true, channel: 'telegram' }),
    };

    const result = await deliver({ telegram: mockSender }, sampleAlert, 'telegram');
    expect(result.success).toBe(true);
    expect(result.channel).toBe('telegram');
    expect(mockSender.send).toHaveBeenCalledWith(sampleAlert);
  });

  it('returns failure when telegram sender is not configured', async () => {
    const result = await deliver({}, sampleAlert, 'telegram');
    expect(result.success).toBe(false);
    expect(result.error).toContain('not configured');
  });

  it('returns failure for unsupported channels', async () => {
    const result = await deliver({}, sampleAlert, 'discord');
    expect(result.success).toBe(false);
    expect(result.error).toContain('not supported');
  });

  it('propagates sender errors', async () => {
    const mockSender: ChannelSender = {
      send: vi.fn().mockResolvedValue({ success: false, channel: 'telegram', error: 'network' }),
    };

    const result = await deliver({ telegram: mockSender }, sampleAlert, 'telegram');
    expect(result.success).toBe(false);
    expect(result.error).toBe('network');
  });
});
