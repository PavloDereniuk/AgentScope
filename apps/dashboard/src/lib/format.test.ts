import { describe, expect, it } from 'vitest';
import { computeInitials, formatInstructionName, relativeTime, shortenSignature } from './format';

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
    expect(computeInitials('pavlo@agentscopehq.dev')).toBe('PA');
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

describe('formatInstructionName', () => {
  it('renders system.transfer as just "Transfer" (no protocol suffix)', () => {
    expect(formatInstructionName('system.transfer')).toEqual({ action: 'Transfer' });
  });

  it('collapses transfer_with_seed into "Transfer"', () => {
    expect(formatInstructionName('system.transfer_with_seed')).toEqual({ action: 'Transfer' });
  });

  it('renders system.create_account as "Create Account"', () => {
    expect(formatInstructionName('system.create_account')).toEqual({ action: 'Create Account' });
  });

  it('renders jupiter.swap with protocol suffix', () => {
    expect(formatInstructionName('jupiter.swap')).toEqual({ action: 'Swap', protocol: 'Jupiter' });
  });

  it('renders kamino.deposit with protocol suffix', () => {
    expect(formatInstructionName('kamino.deposit')).toEqual({
      action: 'Deposit',
      protocol: 'Kamino',
    });
  });

  it('collapses kamino.refresh_* into a muted "Refresh"', () => {
    expect(formatInstructionName('kamino.refresh_reserve')).toEqual({
      action: 'Refresh',
      protocol: 'Kamino',
      muted: true,
    });
  });

  it('collapses kamino.init_* into a muted "Init"', () => {
    expect(formatInstructionName('kamino.init_obligation')).toEqual({
      action: 'Init',
      protocol: 'Kamino',
      muted: true,
    });
  });

  it('renders <namespace>.unknown as "<Protocol> (other)" muted', () => {
    expect(formatInstructionName('jupiter.unknown')).toEqual({
      action: 'Jupiter',
      protocol: '(other)',
      muted: true,
    });
  });

  it('falls back to the raw namespace when the protocol is not in the registry', () => {
    expect(formatInstructionName('xyz1.unknown')).toEqual({
      action: 'xyz1',
      protocol: '(other)',
      muted: true,
    });
  });

  it('rewrites "Bubblegum (cNFT)" to "cNFT"', () => {
    expect(formatInstructionName('Bubblegum (cNFT)')).toEqual({ action: 'cNFT' });
  });

  it('mutes "Compute Budget" since it is only a fallback', () => {
    expect(formatInstructionName('Compute Budget')).toEqual({
      action: 'Compute Budget',
      muted: true,
    });
  });

  it('mutes bare infrastructure friendly names', () => {
    expect(formatInstructionName('System')).toEqual({ action: 'System', muted: true });
    expect(formatInstructionName('Memo')).toEqual({ action: 'Memo', muted: true });
    expect(formatInstructionName('Address Lookup Table')).toEqual({
      action: 'Address Lookup Table',
      muted: true,
    });
  });

  it('passes recognized protocol bare names through unchanged', () => {
    expect(formatInstructionName('Jupiter v6')).toEqual({ action: 'Jupiter v6' });
    expect(formatInstructionName('Kamino Lend')).toEqual({ action: 'Kamino Lend' });
  });

  it('returns a muted dash for null / empty input', () => {
    expect(formatInstructionName(null)).toEqual({ action: '—', muted: true });
    expect(formatInstructionName(undefined)).toEqual({ action: '—', muted: true });
    expect(formatInstructionName('')).toEqual({ action: '—', muted: true });
  });
});
