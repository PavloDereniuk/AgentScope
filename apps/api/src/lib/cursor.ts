/**
 * Opaque cursor encoding for keyset-paginated list endpoints.
 *
 * A cursor represents a stable "seek point" in a DESC-ordered result
 * set: the caller passes the cursor back on the next request and the
 * handler returns rows strictly earlier than it. We use keyset
 * (not offset) pagination for two reasons:
 *   1. Stable under concurrent writes — new rows that land between
 *      pages don't shift already-seen pages.
 *   2. Constant-cost seek via the (block_time, id) index, regardless
 *      of how deep the user paginates.
 *
 * Encoding: base64url-encoded JSON `{ t: ISO-timestamp, i: bigint }`.
 * We prefer base64url over plain base64 so cursors are safe to drop
 * into query strings without percent-escaping.
 */

export interface TxCursor {
  /** ISO-8601 timestamp of the last-seen row's block_time. */
  t: string;
  /** The last-seen row's numeric id (bigserial). */
  i: number;
}

/**
 * Encode a (block_time, id) pair as an opaque cursor string. Callers
 * should treat the result as entirely opaque — only this module may
 * inspect or generate valid cursor contents.
 */
export function encodeTxCursor(blockTime: string, id: number): string {
  const payload: TxCursor = { t: blockTime, i: id };
  return Buffer.from(JSON.stringify(payload), 'utf-8').toString('base64url');
}

/**
 * Decode an opaque cursor string back into `{ t, i }`. Returns `null`
 * on any failure (malformed base64, malformed JSON, wrong shape, bad
 * types) so the caller can convert it into a 422 without leaking
 * implementation details.
 */
export function decodeTxCursor(cursor: string): TxCursor | null {
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf-8');
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof (parsed as { t?: unknown }).t !== 'string' ||
      typeof (parsed as { i?: unknown }).i !== 'number' ||
      !Number.isFinite((parsed as { i: number }).i)
    ) {
      return null;
    }
    return { t: (parsed as TxCursor).t, i: (parsed as TxCursor).i };
  } catch {
    return null;
  }
}
