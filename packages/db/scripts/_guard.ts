/**
 * Shared safety guard for diagnostic scripts.
 *
 * Diagnostic scripts under packages/db/scripts/* often log raw rows to
 * stdout (counts, signatures, partial wallets, sometimes credentials).
 * Terminal scrollback + shell history make any such dump permanent —
 * accidentally pointing DATABASE_URL at a hosted Postgres on a demo-day
 * laptop is enough to leak production data into a recoverable cache.
 *
 * `requireLocalDb` enforces a two-step opt-in for hosted hosts:
 *   1. Detect the hosted provider by URL host substring
 *   2. Demand an explicit `<allowProdEnv>=1` env var to override
 *
 * The single source of truth lives here so every new diagnostic script
 * inherits the guard automatically — past sessions added scripts that
 * skipped this and had to be patched after review.
 */

const HOSTED_HOST_FRAGMENTS = [
  'supabase.co',
  'supabase.com',
  'railway.app',
  'amazonaws.com',
  'neon.tech',
];

export function requireLocalDb(
  scriptName: string,
  allowProdEnv = 'AGENTSCOPE_ALLOW_PROD_DUMP',
): string {
  const url = process.env['DATABASE_URL'];
  if (!url) throw new Error('DATABASE_URL is required');

  const lowerUrl = url.toLowerCase();
  const isHostedProd = HOSTED_HOST_FRAGMENTS.some((h) => lowerUrl.includes(h));

  if (isHostedProd && process.env[allowProdEnv] !== '1') {
    console.error(
      `[${scriptName}] refusing to run against hosted host. ` +
        `Set ${allowProdEnv}=1 if you really mean it.`,
    );
    process.exit(1);
  }

  return url;
}
