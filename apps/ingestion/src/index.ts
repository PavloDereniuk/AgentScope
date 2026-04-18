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

import { createTelegramSender } from '@agentscope/alerter';
import type { DefaultThresholds } from '@agentscope/detector';
import { getKaminoLoadWarnings } from '@agentscope/parser';
import { backfillWallet } from './backfill';
import { loadConfig } from './config';
import { startCron } from './cron';
import { getDb } from './db';
import type { DetectorDeps } from './detector-runner';
import { createEventPublisher } from './event-publisher';
import { logger } from './logger';
import { persistTx } from './persist';
import type { PersistContext } from './persist';
import { createWalletRegistry } from './registry';
import { createWsStream } from './ws-stream';

/** Sensible production defaults — agents may override per-rule via alertRules. */
const DETECTOR_DEFAULTS: DefaultThresholds = {
  slippagePct: 5,
  gasMult: 3,
  drawdownPct: 10,
  errorRatePct: 20,
  staleMinutes: 30,
};

async function main(): Promise<void> {
  const config = loadConfig();

  logger.info(
    {
      network: config.SOLANA_NETWORK,
      rpc: config.SOLANA_RPC_URL.replace(/api-key=[^&]+/, 'api-key=***'),
      env: config.NODE_ENV,
    },
    'ingestion worker started',
  );

  // Flush any warnings accumulated at parser module load (e.g. Kamino
  // discriminator collisions) through the structured logger so they show
  // up in Railway's log search and not just raw stdout.
  for (const w of getKaminoLoadWarnings()) {
    logger.warn(w);
  }

  const db = getDb(config);
  const registry = await createWalletRegistry(db, logger);

  // Set up optional SSE event publisher (requires API_INTERNAL_URL + INTERNAL_SECRET).
  const publishEvent =
    config.API_INTERNAL_URL && config.INTERNAL_SECRET
      ? createEventPublisher(config.API_INTERNAL_URL, config.INTERNAL_SECRET, logger)
      : undefined;

  // Set up optional Telegram alerter (requires TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID).
  const telegramSender =
    config.TELEGRAM_BOT_TOKEN && config.TELEGRAM_CHAT_ID
      ? createTelegramSender({
          botToken: config.TELEGRAM_BOT_TOKEN,
          chatId: config.TELEGRAM_CHAT_ID,
        })
      : undefined;

  // Detector deps shared between tx-triggered runner and periodic cron.
  // Use conditional spread so optional properties are absent (not `undefined`)
  // which is required by exactOptionalPropertyTypes.
  const detectorDeps: DetectorDeps = {
    db,
    logger,
    defaults: DETECTOR_DEFAULTS,
    ...(telegramSender ? { alerter: { telegram: telegramSender } } : {}),
    ...(publishEvent ? { publishEvent } : {}),
  };

  let lastLoggedSlot = 0;
  const stream = await createWsStream(
    {
      rpcUrl: config.SOLANA_RPC_URL,
      ...(config.SOLANA_WS_URL ? { wsUrl: config.SOLANA_WS_URL } : {}),
    },
    {
      onSlot: (slot) => {
        if (slot !== lastLoggedSlot) {
          logger.trace({ slot }, 'slot');
          lastLoggedSlot = slot;
        }
      },
      onTransaction: (tx) => {
        // Fire-and-forget — persist errors are logged inside persistTx.
        void persistTx(
          {
            db,
            registry,
            logger,
            detector: detectorDeps,
            ...(publishEvent ? { publishEvent } : {}),
          },
          tx,
        );
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

  // Track wallets that have already been backfilled so we don't re-run
  // on every 30s reconcile cycle.
  const backfilledWallets = new Set<string>();

  const persistCtx: PersistContext = {
    db,
    registry,
    logger,
    detector: detectorDeps,
    ...(publishEvent ? { publishEvent } : {}),
  };

  /**
   * Run backfill for any wallets that haven't been backfilled yet.
   * Fire-and-forget — errors are logged inside backfillWallet.
   */
  async function backfillNewWallets(): Promise<void> {
    const wallets = registry.wallets();
    for (const wallet of wallets) {
      if (backfilledWallets.has(wallet)) continue;
      backfilledWallets.add(wallet);
      try {
        await backfillWallet(
          wallet,
          { rpcUrl: config.SOLANA_RPC_URL, maxSignatures: 50 },
          persistCtx,
          logger,
        );
      } catch (err) {
        logger.error({ err, wallet }, 'backfill failed for wallet');
      }
    }
  }

  // Backfill existing wallets on startup.
  void backfillNewWallets();

  let reconciling: Promise<void> | null = null;
  const reconcileTimer = setInterval(() => {
    // Guard against overlapping calls if reconcileWallets takes > 30s.
    if (reconciling) return;
    reconciling = stream
      .reconcileWallets(registry.wallets())
      .then(() => backfillNewWallets())
      .catch((err) => logger.error({ err }, 'wallet reconcile failed'))
      .finally(() => {
        reconciling = null;
      });
  }, 30_000);

  // Start periodic cron for time-based rules (drawdown, error_rate, stale_agent).
  const cron = startCron({ db, logger, defaults: DETECTOR_DEFAULTS });
  logger.info('cron evaluator started');

  // Graceful shutdown handlers. Wait for any in-flight reconcile so we
  // don't cut the stream mid-subscribe — otherwise the fresh process
  // may inherit dangling server-side state on restart.
  const shutdown = (signal: string) => {
    logger.info({ signal }, 'shutting down');
    clearInterval(reconcileTimer);
    cron.stop();
    registry.stop();
    Promise.resolve(reconciling)
      .catch(() => undefined)
      .then(() => stream.close())
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
