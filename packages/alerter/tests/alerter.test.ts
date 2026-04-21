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
  it('formats an alert with severity icon, human title, summary and detail rows', () => {
    const text = formatTelegramMessage(sampleAlert);
    expect(text).toContain('⚠️');
    expect(text).toContain('Slippage Spike');
    expect(text).toContain('Trading Bot');
    // Summary line with human metric
    expect(text).toContain('Swap slipped 12%');
    // Detail rows use human labels, not raw payload keys
    expect(text).toContain('Actual slippage');
    expect(text).toContain('12%');
    expect(text).not.toContain('actualPct');
    // Severity is in the title line; no separate "Severity:" row
    expect(text).not.toMatch(/^Severity: /m);
  });

  it('uses critical icon for critical severity', () => {
    const critical = { ...sampleAlert, severity: 'critical' as const };
    const text = formatTelegramMessage(critical);
    expect(text).toContain('🚨');
  });

  it('marks non-base58 signatures as demo (no link)', () => {
    const demo = {
      ...sampleAlert,
      payload: { ...sampleAlert.payload, signature: 'demo-abc_xyz-not-on-chain' },
    };
    const text = formatTelegramMessage(demo);
    expect(text).toContain('(demo)');
    expect(text).not.toContain('solscan.io');
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
