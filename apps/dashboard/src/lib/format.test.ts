import { describe, expect, it } from 'vitest';
import { computeInitials, relativeTime, shortenSignature } from './format';

describe('relativeTime', () => {
  const now = new Date('2026-04-22T12:00:00.000Z').getTime();

  it('returns "just now" for <1 minute', () => {
    expect(relativeTime('2026-04-22T11:59:30.000Z', now)).toBe('just now');
  });
  it('formats minutes', () => {
    expect(relativeTime('2026-04-22T11:55:00.000Z', now)).toBe('5m ago');
  });
  it('formats hours once past 60 minutes', () => {
    expect(relativeTime('2026-04-22T09:00:00.000Z', now)).toBe('3h ago');
  });
  it('switches to days past 24h', () => {
    expect(relativeTime('2026-04-20T12:00:00.000Z', now)).toBe('2d ago');
  });
});

describe('computeInitials', () => {
  it('takes the local part of an email', () => {
    expect(computeInitials('pavlo@agentscope.dev')).toBe('PA');
  });
  it('uppercases and slices raw identifiers', () => {
    expect(computeInitials('solana7fK')).toBe('SO');
  });
  it('falls back to AS for empty / unreadable input', () => {
    expect(computeInitials('')).toBe('AS');
    expect(computeInitials('!!!')).toBe('AS');
  });
});

describe('shortenSignature', () => {
  it('keeps short strings untouched', () => {
    expect(shortenSignature('abc123')).toBe('abc123');
  });
  it('elides the middle of long base58 signatures', () => {
    expect(shortenSignature('5vKxABCDEFGHIJKLMNJp9')).toBe('5vKxAB…LMNJp9');
  });
});
