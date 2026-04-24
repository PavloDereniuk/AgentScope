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
import { createAdminTelegramSender, startAbuseMonitor } from './abuse-monitor';
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
import { startTelegramBot } from './telegram-bot';
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

  // Set up optional Telegram alerter — only needs the bot token; per-agent
  // chat_id travels on each AlertMessage (multi-tenant safety: no
  // deployer-wide chat_id fallback). Demo agents have their
  // `agents.telegram_chat_id` column set explicitly in the DB.
  const telegramSender = config.TELEGRAM_BOT_TOKEN
    ? createTelegramSender({ botToken: config.TELEGRAM_BOT_TOKEN })
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

  // In-flight persist tracker. Each onTransaction handler is fire-and-forget,
  // but on SIGTERM we need to wait for them to finish so transactions received
  // milliseconds before the signal aren't lost (along with their detector/alert
  // runs). Same pattern as event-publisher's MAX_IN_FLIGHT.
  let persistsInFlight = 0;
  const persistContext: PersistContext = {
    db,
    registry,
    logger,
    detector: detectorDeps,
    ...(publishEvent ? { publishEvent } : {}),
  };

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
        persistsInFlight++;
        void persistTx(persistContext, tx).finally(() => {
          persistsInFlight--;
        });
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
          persistContext,
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
  // Pass alerter + publishEvent so cron-triggered alerts reach Telegram and
  // the dashboard SSE bus — same channels the tx-triggered detector uses.
  const cron = startCron({
    db,
    logger,
    defaults: DETECTOR_DEFAULTS,
    ...(telegramSender ? { alerter: { telegram: telegramSender } } : {}),
    ...(publishEvent ? { publishEvent } : {}),
  });
  logger.info('cron evaluator started');

  // 14.16 — abuse signup-spike monitor. Runs even without Telegram creds
  // (logs-only mode) so local dev still shows the signal; production
  // alerts when TELEGRAM_BOT_TOKEN + TELEGRAM_ADMIN_CHAT_ID are both
  // set.
  const adminSender =
    config.TELEGRAM_BOT_TOKEN && config.TELEGRAM_ADMIN_CHAT_ID
      ? createAdminTelegramSender(config.TELEGRAM_BOT_TOKEN, config.TELEGRAM_ADMIN_CHAT_ID)
      : undefined;
  const abuseMonitor = startAbuseMonitor({
    db,
    logger,
    ...(adminSender ? { sendAdminMessage: adminSender } : {}),
  });
  logger.info({ adminAlerts: Boolean(adminSender) }, 'abuse monitor started');

  // Start Telegram bot long-poll worker for the /start <code> deep-link
  // flow (Epic 14 Phase 2). Skipped when no bot token is configured —
  // the dashboard's "Link Telegram" button degrades to a manual chat_id
  // input on the same Settings page (still functional, just one extra
  // copy-paste). Single-instance assumption: do not horizontally scale
  // ingestion or two pods will race for getUpdates ownership.
  const telegramBot = config.TELEGRAM_BOT_TOKEN
    ? startTelegramBot({ db, logger, botToken: config.TELEGRAM_BOT_TOKEN })
    : null;

  // Graceful shutdown handlers. Wait for any in-flight reconcile so we
  // don't cut the stream mid-subscribe — otherwise the fresh process
  // may inherit dangling server-side state on restart. Also wait (up to
  // 5s) for in-flight persistTx calls so transactions received moments
  // before the signal still reach the db and the detector.
  const PERSIST_DRAIN_TIMEOUT_MS = 5_000;
  const PERSIST_DRAIN_POLL_MS = 50;

  async function drainPersists(): Promise<void> {
    if (persistsInFlight === 0) return;
    logger.info({ persistsInFlight }, 'draining in-flight persists');
    const deadline = Date.now() + PERSIST_DRAIN_TIMEOUT_MS;
    while (persistsInFlight > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, PERSIST_DRAIN_POLL_MS));
    }
    if (persistsInFlight > 0) {
      logger.warn(
        { persistsInFlight, timeoutMs: PERSIST_DRAIN_TIMEOUT_MS },
        'persist drain timed out — some transactions may not have persisted',
      );
    }
  }

  const shutdown = (signal: string) => {
    logger.info({ signal }, 'shutting down');
    clearInterval(reconcileTimer);
    cron.stop();
    abuseMonitor.stop();
    registry.stop();
    Promise.resolve(reconciling)
      .catch(() => undefined)
      .then(() => drainPersists())
      .then(() => telegramBot?.stop())
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
