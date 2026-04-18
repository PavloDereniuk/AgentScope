/**
 * In-memory cache of registered agent wallet pubkeys → agent IDs.
 *
 * Refreshed periodically from the `agents` table so newly-registered
 * agents are picked up without restarting the worker. The cache is
 * read-mostly (every incoming tx hits it) so we keep it in a plain Map.
 */

import { type Database, agents } from '@agentscope/db';
import type { Logger } from './logger';

export interface WalletRegistry {
  /** Look up agent_id for a wallet pubkey, or undefined if unknown. */
  lookup(walletPubkey: string): string | undefined;
  /** Current count of registered wallets (for logs). */
  size(): number;
  /** All known wallets (for Yellowstone accountInclude filter in 2.12). */
  wallets(): string[];
  /** Force a refresh from the DB. */
  refresh(): Promise<void>;
  /** Stop the periodic refresh timer. */
  stop(): void;
}

export interface RegistryOptions {
  /** Periodic refresh interval in ms. Default 30s. */
  refreshIntervalMs?: number;
}

/** Safety cap on a single registry refresh query. */
const MAX_REGISTERED_AGENTS = 10_000;

export async function createWalletRegistry(
  db: Database,
  logger: Logger,
  options: RegistryOptions = {},
): Promise<WalletRegistry> {
  const refreshInterval = options.refreshIntervalMs ?? 30_000;
  // Cache reference is reassignable — refresh() builds a new Map and
  // atomically swaps it in so in-flight lookup() calls never see a
  // half-populated state (clear-then-fill would create a miss window).
  let cache = new Map<string, string>();

  async function refresh(): Promise<void> {
    const rows = await db
      .select({ id: agents.id, walletPubkey: agents.walletPubkey })
      .from(agents)
      .limit(MAX_REGISTERED_AGENTS);

    const next = new Map<string, string>();
    for (const row of rows) {
      next.set(row.walletPubkey, row.id);
    }
    cache = next;
    if (rows.length >= MAX_REGISTERED_AGENTS) {
      logger.warn(
        { limit: MAX_REGISTERED_AGENTS },
        'wallet registry hit LIMIT — some agents will not be monitored',
      );
    }
    logger.trace({ count: cache.size }, 'wallet registry refreshed');
  }

  await refresh();
  logger.info({ count: cache.size }, 'wallet registry initialized');

  const timer = setInterval(() => {
    refresh().catch((err) => {
      logger.error({ err }, 'wallet registry refresh failed');
    });
  }, refreshInterval);

  return {
    lookup: (walletPubkey: string) => cache.get(walletPubkey),
    size: () => cache.size,
    wallets: () => Array.from(cache.keys()),
    refresh,
    stop: () => clearInterval(timer),
  };
}
