/**
 * Little-endian integer readers for the non-Anchor parsers.
 *
 * The System Program and SPL Token both use hand-rolled byte layouts rather
 * than an IDL, so both need the same two primitives. Every reader returns
 * `null` on a short buffer instead of throwing or reading garbage — a
 * truncated instruction must degrade to `<namespace>.unknown`, never to a
 * confidently wrong amount.
 *
 * u64 values come back as decimal *strings*: SPL amounts routinely reach
 * u64::MAX (the unlimited-approval sentinel), which loses its last three
 * digits the moment it passes through a JS number.
 */

export function readU32LE(data: Uint8Array, offset: number): number | null {
  if (offset + 4 > data.length) return null;
  return (
    (data[offset] ?? 0) +
    ((data[offset + 1] ?? 0) << 8) +
    ((data[offset + 2] ?? 0) << 16) +
    (data[offset + 3] ?? 0) * 0x1000000
  );
}

export function readU64LE(data: Uint8Array, offset: number): string | null {
  if (offset + 8 > data.length) return null;
  let value = 0n;
  for (let i = 7; i >= 0; i--) {
    value = (value << 8n) | BigInt(data[offset + i] ?? 0);
  }
  return value.toString();
}
