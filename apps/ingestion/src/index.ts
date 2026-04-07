/**
 * AgentScope ingestion worker entrypoint.
 *
 * Responsibilities (built up across tasks 1.8 → 5.10):
 *   1.8  — startup logging + env config (this file)
 *   1.9  — Yellowstone gRPC client connection
 *   1.10 — subscribe to devnet transactions
 *   1.11 — persist raw transactions to agent_transactions
 *   2.11 — invoke parser + update parsed_args
 *   2.12 — filter by registered agent wallets
 *   5.9  — invoke detector after each persist
 *   5.10 — periodic cron for time-based rules
 *   5.14 — alerter delivery on detector trigger
 */

import { loadConfig } from './config';
import {
  attachStreamHandlers,
  buildSubscribeRequest,
  connectYellowstone,
  sendSubscribeRequest,
} from './grpc-client';
import { logger } from './logger';

async function main(): Promise<void> {
  const config = loadConfig();

  logger.info(
    {
      network: config.SOLANA_NETWORK,
      yellowstone: config.YELLOWSTONE_GRPC_URL,
      env: config.NODE_ENV,
    },
    'ingestion worker started',
  );

  const { stream } = await connectYellowstone({
    url: config.YELLOWSTONE_GRPC_URL,
    token: config.YELLOWSTONE_GRPC_TOKEN,
  });

  let lastLoggedSlot = 0;
  const detach = attachStreamHandlers(
    stream,
    {
      onSlot: (slot) => {
        if (slot !== lastLoggedSlot) {
          logger.debug({ slot }, 'slot');
          lastLoggedSlot = slot;
        }
      },
      onTransaction: (tx) => {
        // Task 1.10: log signature + program_ids for any non-vote tx.
        // Task 1.11 will write the raw row to agent_transactions.
        // Task 2.12 will narrow the subscription filter to registered wallets.
        logger.info(
          {
            sig: tx.signature,
            slot: tx.slot,
            programs: tx.programIds,
          },
          'tx',
        );
      },
      onPing: () => logger.debug('yellowstone ping'),
      onError: (err) => {
        logger.error({ err }, 'yellowstone subscription failed; exiting for restart');
        process.exit(1);
      },
      onEnd: () => {
        logger.warn('yellowstone stream ended; exiting for restart');
        process.exit(1);
      },
    },
    logger,
  );

  await sendSubscribeRequest(stream, buildSubscribeRequest({ slots: true, transactions: true }));
  logger.info('subscribed to slots + transactions (CONFIRMED, no account filter)');

  // Graceful shutdown handlers — detach + close stream + flush pino.
  const shutdown = (signal: string) => {
    logger.info({ signal }, 'shutting down');
    detach();
    stream.end();
    setTimeout(() => process.exit(0), 100);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.fatal({ err }, 'ingestion worker crashed');
  process.exit(1);
});
