/**
 * Tests for alerter package (tasks 5.11-5.13 + Epic 14 webhook).
 *
 * Covers Telegram message formatting, the deliver() strategy router,
 * and the webhook sender's POST shape, retry-on-5xx and no-retry-on-4xx
 * behavior.
 */

import { describe, expect, it, vi } from 'vitest';
import { deliver } from '../src/deliver';
import { createTelegramSender, formatTelegramMessage } from '../src/telegram';
import type { AlertMessage, ChannelSender } from '../src/types';
import { createWebhookSender } from '../src/webhook';

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

  it('routes to webhook sender when channel is webhook', async () => {
    const mockSender: ChannelSender = {
      send: vi.fn().mockResolvedValue({ success: true, channel: 'webhook' }),
    };

    const result = await deliver({ webhook: mockSender }, sampleAlert, 'webhook');
    expect(result.success).toBe(true);
    expect(result.channel).toBe('webhook');
    expect(mockSender.send).toHaveBeenCalledWith(sampleAlert);
  });

  it('returns failure when webhook sender is not configured', async () => {
    const result = await deliver({}, sampleAlert, 'webhook');
    expect(result.success).toBe(false);
    expect(result.error).toContain('not configured');
  });

  it('returns failure for discord/slack until MVP support lands', async () => {
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

describe('createTelegramSender — multi-tenant safety', () => {
  it('returns failure (does NOT fetch) when AlertMessage has no chatId', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      const sender = createTelegramSender({ botToken: 'bot:FAKE_TOKEN' });
      const result = await sender.send(sampleAlert); // sampleAlert has no chatId
      expect(result.success).toBe(false);
      expect(result.channel).toBe('telegram');
      expect(result.error).toMatch(/no telegram chat_id/i);
      // Critical: no Telegram API call was attempted — no fallback to a
      // deployer-wide chat.
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('returns failure for empty/whitespace chatId', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      const sender = createTelegramSender({ botToken: 'bot:FAKE_TOKEN' });
      const result = await sender.send({ ...sampleAlert, chatId: '   ' });
      expect(result.success).toBe(false);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('sends successfully when chatId is present', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    try {
      const sender = createTelegramSender({ botToken: 'bot:FAKE_TOKEN' });
      const result = await sender.send({ ...sampleAlert, chatId: '123456789' });
      expect(result.success).toBe(true);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string);
      expect(body.chat_id).toBe('123456789');
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('rejects empty botToken at construction time', () => {
    expect(() => createTelegramSender({ botToken: '' })).toThrow(/botToken/);
  });
});

describe('createWebhookSender', () => {
  const url = 'https://example.com/hooks/abc';

  function makeResponse(status: number, body = ''): Response {
    return new Response(body, {
      status,
      headers: { 'Content-Type': 'text/plain' },
    });
  }

  it('posts JSON payload with {alert, agent} shape and Content-Type header', async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeResponse(200, 'ok'));
    const sender = createWebhookSender({ url }, fetchMock);

    const result = await sender.send(sampleAlert);

    expect(result.success).toBe(true);
    expect(result.channel).toBe('webhook');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [calledUrl, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(calledUrl).toBe(url);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');

    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({
      alert: {
        id: 'alert-1',
        ruleName: 'slippage_spike',
        severity: 'warning',
        payload: sampleAlert.payload,
        triggeredAt: sampleAlert.triggeredAt,
      },
      agent: { id: 'agent-1', name: 'Trading Bot' },
    });
  });

  it('retries up to 3 times on 5xx and succeeds on the final attempt', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(makeResponse(503))
      .mockResolvedValueOnce(makeResponse(502))
      .mockResolvedValueOnce(makeResponse(200, 'ok'));
    const sender = createWebhookSender({ url }, fetchMock);

    const result = await sender.send(sampleAlert);

    expect(result.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('does NOT retry on 4xx (client error) — returns failure immediately', async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeResponse(404, 'not found'));
    const sender = createWebhookSender({ url }, fetchMock);

    const result = await sender.send(sampleAlert);

    expect(result.success).toBe(false);
    expect(result.channel).toBe('webhook');
    expect(result.error).toContain('404');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries on network error and returns the last error after exhausting retries', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const sender = createWebhookSender({ url }, fetchMock);

    const result = await sender.send(sampleAlert);

    expect(result.success).toBe(false);
    expect(result.error).toContain('ECONNREFUSED');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('truncates error messages to 200 chars to match alerts.delivery_error column shape', async () => {
    const longBody = 'x'.repeat(500);
    const fetchMock = vi.fn().mockResolvedValue(makeResponse(400, longBody));
    const sender = createWebhookSender({ url }, fetchMock);

    const result = await sender.send(sampleAlert);

    expect(result.success).toBe(false);
    expect(result.error?.length ?? 0).toBeLessThanOrEqual(200);
  });

  it('rejects non-http(s) URLs at construction time', () => {
    expect(() => createWebhookSender({ url: 'ftp://example.com/x' })).toThrow(/http\(s\)/);
  });

  it('rejects empty URL at construction time', () => {
    expect(() => createWebhookSender({ url: '' })).toThrow(/required/);
  });
});
