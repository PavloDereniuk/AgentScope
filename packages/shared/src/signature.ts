/**
 * Canonical Solana signature validator.
 *
 * Mainnet signatures are 64-byte Ed25519 outputs encoded in base58,
 * which yields ~64-88 characters depending on leading-zero bytes.
 * We accept `{32,88}` on the low end to keep test fixtures with many
 * leading zeros parseable (they still encode to valid base58, just
 * with compressed length). The upper bound is 88 — 90 was a historical
 * off-by-two that let base64-ish demo strings through.
 *
 * All producers (OTLP receiver, eliza hooks, alerter, dashboard renderer)
 * must import this constant so the accept-set never diverges again.
 */
export const SOLANA_SIGNATURE_RE = /^[1-9A-HJ-NP-Za-km-z]{32,88}$/;

export function isSolanaSignature(sig: string): boolean {
  return SOLANA_SIGNATURE_RE.test(sig);
}
