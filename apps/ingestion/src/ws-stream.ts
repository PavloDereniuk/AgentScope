/**
 * WebSocket-based fallback for environments without Yellowstone gRPC
 * (Helius LaserStream is paywalled on the Free plan).
 *
 * Uses @solana/web3.js Connection with `onLogs` and `onSlotChange`
 * subscriptions over the standard JSON-RPC WebSocket. Slower than
 * gRPC (~1-3s latency vs ~500ms) but works on free RPC tiers.
 *
 * Mirrors the public shape of grpc-client.ts so index.ts can swap
 * implementations with a single import change. The grpc client remains
 * in the repo for when LaserStream / Triton becomes available.
 */

import { Connection, type Context, type Logs, PublicKey } from '@solana/web3.js';
import type { TxUpdate } from './grpc-client';
import type { Logger } from './logger';

export interface WsStreamHandlers {
  onSlot?: (slot: number) => void;
  onTransaction?: (tx: TxUpdate) => void;
  onError?: (err: Error) => void;
}

export interface WsStreamOptions {
  /** HTTP RPC URL (for getTransaction fetches). */
  rpcUrl: string;
  /** WebSocket URL — defaults to rpcUrl with `https→wss`. */
  wsUrl?: string;
}

export interface WsStream {
  /** Subscribe to logs mentioning the given wallet. Returns subscription id. */
  subscribeWallet(walletPubkey: string): Promise<number>;
  /** Unsubscribe from a specific subscription. */
  unsubscribeWallet(subId: number): Promise<void>;
  /** Replace the set of subscribed wallets atomically. */
  reconcileWallets(wallets: string[]): Promise<void>;
  /** Stop slot subscription and disconnect. */
  close(): Promise<void>;
}

function deriveWsUrl(httpUrl: string): string {
  return httpUrl.replace(/^http/, 'ws');
}

export async function createWsStream(
  opts: WsStreamOptions,
  handlers: WsStreamHandlers,
  logger: Logger,
): Promise<WsStream> {
  const wsUrl = opts.wsUrl ?? deriveWsUrl(opts.rpcUrl);
  const connection = new Connection(opts.rpcUrl, {
    commitment: 'confirmed',
    wsEndpoint: wsUrl,
  });

  // Slot subscription — single per connection.
  let slotSubId: number | null = null;
  if (handlers.onSlot) {
    slotSubId = connection.onSlotChange((slotInfo) => {
      handlers.onSlot?.(slotInfo.slot);
    });
    logger.info({ slotSubId }, 'subscribed to slot updates');
  }

  // walletPubkey -> { subId, pubkey }
  const walletSubs = new Map<string, number>();

  /**
   * Hydrate a log event into a TxUpdate by fetching the full transaction.
   * The onLogs callback only gives us signature + raw log lines, so we
   * need a follow-up RPC call to get program IDs and account keys.
   */
  async function handleLogs(logs: Logs, ctx: Context): Promise<void> {
    if (logs.err) return; // skip failed tx

    try {
      const tx = await connection.getTransaction(logs.signature, {
        maxSupportedTransactionVersion: 0,
        commitment: 'confirmed',
      });
      if (!tx) {
        logger.warn({ sig: logs.signature }, 'tx not found in getTransaction');
        return;
      }

      const message = tx.transaction.message;
      const staticKeys = message.staticAccountKeys.map((k) => k.toBase58());
      const loadedWritable = (tx.meta?.loadedAddresses?.writable ?? []).map((k) => k.toBase58());
      const loadedReadonly = (tx.meta?.loadedAddresses?.readonly ?? []).map((k) => k.toBase58());
      const allKeys = [...staticKeys, ...loadedWritable, ...loadedReadonly];

      const compiledIxs = message.compiledInstructions;
      const programIds = Array.from(
        new Set(
          compiledIxs
            .map((ix) => allKeys[ix.programIdIndex])
            .filter((k): k is string => Boolean(k)),
        ),
      );

      const update: TxUpdate = {
        signature: logs.signature,
        slot: ctx.slot,
        blockTime: tx.blockTime
          ? new Date(tx.blockTime * 1000).toISOString()
          : new Date().toISOString(),
        isVote: false,
        programIds,
        rawAccountKeys: staticKeys,
        rawTx: tx,
      };

      handlers.onTransaction?.(update);
    } catch (err) {
      logger.error({ err, sig: logs.signature }, 'failed to hydrate tx from log');
      handlers.onError?.(err as Error);
    }
  }

  async function subscribeWallet(walletPubkey: string): Promise<number> {
    if (walletSubs.has(walletPubkey)) {
      const existing = walletSubs.get(walletPubkey);
      if (existing !== undefined) return existing;
    }
    const pk = new PublicKey(walletPubkey);
    const subId = connection.onLogs(
      pk,
      (logs, ctx) => {
        void handleLogs(logs, ctx);
      },
      'confirmed',
    );
    walletSubs.set(walletPubkey, subId);
    logger.debug({ walletPubkey, subId }, 'subscribed to wallet logs');
    return subId;
  }

  async function unsubscribeWallet(subId: number): Promise<void> {
    await connection.removeOnLogsListener(subId);
    for (const [w, id] of walletSubs.entries()) {
      if (id === subId) {
        walletSubs.delete(w);
        break;
      }
    }
  }

  async function reconcileWallets(wallets: string[]): Promise<void> {
    const desired = new Set(wallets);
    const current = new Set(walletSubs.keys());

    // Unsubscribe wallets that disappeared.
    for (const wallet of current) {
      if (!desired.has(wallet)) {
        const subId = walletSubs.get(wallet);
        if (subId !== undefined) {
          await unsubscribeWallet(subId);
        }
      }
    }

    // Subscribe new wallets.
    for (const wallet of desired) {
      if (!current.has(wallet)) {
        await subscribeWallet(wallet);
      }
    }

    logger.info(
      { added: wallets.filter((w) => !current.has(w)).length, total: walletSubs.size },
      'wallet subscriptions reconciled',
    );
  }

  async function close(): Promise<void> {
    if (slotSubId !== null) {
      await connection.removeSlotChangeListener(slotSubId);
    }
    for (const subId of walletSubs.values()) {
      await connection.removeOnLogsListener(subId);
    }
    walletSubs.clear();
  }

  return {
    subscribeWallet,
    unsubscribeWallet,
    reconcileWallets,
    close,
  };
}
