/**
 * Unit tests for the opaque cursor helpers used by the paginated
 * transactions endpoint (task 3.10). Pure functions, no I/O.
 */

import { describe, expect, it } from 'vitest';
import { decodeTxCursor, encodeTxCursor } from '../src/lib/cursor';

describe('cursor helpers', () => {
  it('round-trips a (blockTime, id) pair', () => {
    const encoded = encodeTxCursor('2026-04-08T12:00:00.000Z', 42);
    expect(typeof encoded).toBe('string');
    const decoded = decodeTxCursor(encoded);
    expect(decoded).toEqual({ t: '2026-04-08T12:00:00.000Z', i: 42 });
  });

  it('produces a url-safe opaque string (base64url, no + / =)', () => {
    const encoded = encodeTxCursor('2026-04-08T12:00:00.000Z', 999_999);
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('returns null for a non-base64 garbage cursor', () => {
    expect(decodeTxCursor('!!!not base64!!!')).toBeNull();
  });

  it('returns null when the decoded payload is not valid json', () => {
    const garbage = Buffer.from('not json', 'utf-8').toString('base64url');
    expect(decodeTxCursor(garbage)).toBeNull();
  });

  it('returns null when the decoded object is missing fields', () => {
    const badShape = Buffer.from(JSON.stringify({ t: '2026-04-08T12:00:00.000Z' })).toString(
      'base64url',
    );
    expect(decodeTxCursor(badShape)).toBeNull();
  });

  it('returns null when i is not a finite number', () => {
    const nanPayload = Buffer.from(
      JSON.stringify({ t: '2026-04-08T12:00:00.000Z', i: 'abc' }),
    ).toString('base64url');
    expect(decodeTxCursor(nanPayload)).toBeNull();
  });
});
