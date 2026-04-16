/**
 * AgentScope ingestion worker entrypoint.
 *
 * Responsibilities (built up across tasks 1.8 → 5.10):
 *   1.8  — startup logging + env config
 *   1.9  — Yellowstone gRPC client (paywalled on Helius free → unused)
 *   1.9b — WebSocket fallback via @solana/web3.js (current implementation)
 *   1.10 — subscribe to devnet transactions
 *   1.11 — persist raw transactions to agent_transactions
 *   2.11 — invoke parser + update parsed_args
 *   2.12 — narrow subscriptions to registered agent wallets only
 *   5.9  — invoke detector after each persist
 *   5.10 — periodic cron for time-based rules
 *   5.14 — alerter delivery on detector trigger
 */

import { loadConfig } from './config';
import { getDb } from './db';
import { logger } from './logger';
import { persistTx } from './persist';
import { createWalletRegistry } from './registry';
import { createWsStream } from './ws-stream';

async function main(): Promise<void> {
  const config = loadConfig();

  logger.info(
    {
      network: config.SOLANA_NETWORK,
      rpc: config.SOLANA_RPC_URL,
      env: config.NODE_ENV,
    },
    'ingestion worker started',
  );

  const db = getDb(config);
  const registry = await createWalletRegistry(db, logger);

  let lastLoggedSlot = 0;
  const stream = await createWsStream(
    {
      rpcUrl: config.SOLANA_RPC_URL,
      ...(config.SOLANA_WS_URL ? { wsUrl: config.SOLANA_WS_URL } : {}),
    },
    {
      onSlot: (slot) => {
        if (slot !== lastLoggedSlot) {
          logger.debug({ slot }, 'slot');
          lastLoggedSlot = slot;
        }
      },
      onTransaction: (tx) => {
        // Fire-and-forget — persist errors are logged inside persistTx.
        void persistTx({ db, registry, logger }, tx);
      },
      onError: (err) => {
        logger.error({ err }, 'rpc stream error');
      },
    },
    logger,
  );

  // Subscribe to logs for every registered wallet, and refresh whenever
  // the registry refreshes (every 30s — see registry.ts).
  await stream.reconcileWallets(registry.wallets());
  logger.info({ registeredAgents: registry.size() }, 'subscribed to logs for registered wallets');

  let reconciling = false;
  const reconcileTimer = setInterval(() => {
    // Guard against overlapping calls if reconcileWallets takes > 30s.
    if (reconciling) return;
    reconciling = true;
    stream
      .reconcileWallets(registry.wallets())
      .catch((err) => logger.error({ err }, 'wallet reconcile failed'))
      .finally(() => {
        reconciling = false;
      });
  }, 30_000);

  // Graceful shutdown handlers.
  const shutdown = (signal: string) => {
    logger.info({ signal }, 'shutting down');
    clearInterval(reconcileTimer);
    registry.stop();
    stream
      .close()
      .catch((err) => logger.error({ err }, 'stream close failed'))
      .finally(() => process.exit(0));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.fatal({ err }, 'ingestion worker crashed');
  process.exit(1);
});
