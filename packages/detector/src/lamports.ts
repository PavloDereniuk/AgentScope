/**
 * Lamport arithmetic shared by the security rules.
 *
 * `sol_delta` is a `numeric(20,9)` column and lands in JS as a decimal string
 * ("-0.420005000"). Parsing it with `Number.parseFloat` starts losing whole
 * lamports well before the column's range runs out, and these rules compare
 * outflows against balances — the exact place where silent rounding turns a
 * drain into a rounding error. Everything below stays in BigInt.
 */

export const LAMPORTS_PER_SOL = 1_000_000_000n;

/**
 * Parse a decimal SOL string into lamports. Returns 0n for anything
 * unparseable — the callers treat that as "no signal", which beats throwing
 * away a whole evaluation over one malformed row.
 */
export function solStringToLamports(sol: string): bigint {
  const trimmed = sol.trim();
  const negative = trimmed.startsWith('-');
  const unsigned = negative ? trimmed.slice(1) : trimmed;
  const [whole = '0', frac = ''] = unsigned.split('.');
  const fracPadded = `${frac}000000000`.slice(0, 9);
  try {
    const lamports = BigInt(whole || '0') * LAMPORTS_PER_SOL + BigInt(fracPadded || '0');
    return negative ? -lamports : lamports;
  } catch {
    return 0n;
  }
}

/** Lamports → SOL as a plain number, for alert payloads and log lines. */
export function lamportsToSol(lamports: bigint): number {
  return Number(lamports) / Number(LAMPORTS_PER_SOL);
}
