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

export async function createWalletRegistry(
  db: Database,
  logger: Logger,
  options: RegistryOptions = {},
): Promise<WalletRegistry> {
  const refreshInterval = options.refreshIntervalMs ?? 30_000;
  const cache = new Map<string, string>();

  async function refresh(): Promise<void> {
    const rows = await db.select({ id: agents.id, walletPubkey: agents.walletPubkey }).from(agents);

    cache.clear();
    for (const row of rows) {
      cache.set(row.walletPubkey, row.id);
    }
    logger.debug({ count: cache.size }, 'wallet registry refreshed');
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
