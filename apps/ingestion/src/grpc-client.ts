/**
 * Yellowstone gRPC client wrapper.
 *
 * Connects to a Geyser-compatible gRPC endpoint (Helius / Triton),
 * opens a duplex `subscribe()` stream, and exposes typed helpers for
 * sending SubscribeRequest filters and consuming SubscribeUpdate events.
 *
 * Streaming model: the stream is long-lived. Re-subscribing to a new
 * filter just writes another SubscribeRequest on the same stream.
 * The stream errors out on network failure and is rebuilt by the caller
 * (see reconnection logic in index.ts).
 */

import type { ClientDuplexStream } from '@grpc/grpc-js';
import type { VersionedTransactionResponse } from '@solana/web3.js';
import Client, {
  CommitmentLevel,
  type SubscribeRequest,
  type SubscribeUpdate,
} from '@triton-one/yellowstone-grpc';
import bs58 from 'bs58';
import type { Logger } from './logger';

export type YellowstoneStream = ClientDuplexStream<SubscribeRequest, SubscribeUpdate>;

export interface YellowstoneConnection {
  client: Client;
  stream: YellowstoneStream;
}

export interface YellowstoneOptions {
  url: string;
  token?: string | undefined;
  /** gRPC channel options (max message size etc). */
  channelOptions?: Record<string, unknown>;
}

/**
 * Open a long-lived gRPC subscribe stream.
 * Caller must keep the returned `stream` reference; closing it ends the subscription.
 */
export async function connectYellowstone(opts: YellowstoneOptions): Promise<YellowstoneConnection> {
  const client = new Client(opts.url, opts.token, opts.channelOptions);
  const stream = await client.subscribe();
  return { client, stream };
}

/**
 * Send a SubscribeRequest on the stream and resolve once the server has
 * acknowledged it (or reject on transport error).
 */
export function sendSubscribeRequest(
  stream: YellowstoneStream,
  request: SubscribeRequest,
): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.write(request, (err: Error | null | undefined) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

/**
 * Build a minimal SubscribeRequest at CONFIRMED commitment.
 * Pass `slots: true` to receive slot updates and/or `transactions: true`
 * to receive non-vote, non-failed transactions (no account filtering yet —
 * task 2.12 will narrow this to registered agent wallets).
 */
export function buildSubscribeRequest(opts: {
  slots?: boolean;
  transactions?: boolean;
  /** Optional account-include filter for tx subscription. */
  accountInclude?: string[];
}): SubscribeRequest {
  return {
    accounts: {},
    slots: opts.slots ? { client: { filterByCommitment: true } } : {},
    transactions: opts.transactions
      ? {
          client: {
            vote: false,
            failed: false,
            accountInclude: opts.accountInclude ?? [],
            accountExclude: [],
            accountRequired: [],
          },
        }
      : {},
    transactionsStatus: {},
    blocks: {},
    blocksMeta: {},
    entry: {},
    accountsDataSlice: [],
    commitment: CommitmentLevel.CONFIRMED,
  };
}

/**
 * Lightweight projection of a transaction update — just the bits we
 * need to log / route to parsers, without dragging the full proto type
 * through the rest of the codebase.
 *
 * `rawTx` is optional and only populated by streams that fetch a
 * VersionedTransactionResponse alongside the program-id projection
 * (e.g. ws-stream's getTransaction hydrate path). The grpc client
 * leaves it undefined because Yellowstone gRPC streams the same data
 * inline and a separate VersionedTransactionResponse reconstruction
 * isn't worth the cost.
 */
export interface TxUpdate {
  signature: string;
  slot: number;
  /** Block timestamp ISO string when known; otherwise the receive time. */
  blockTime: string;
  isVote: boolean;
  programIds: string[];
  rawAccountKeys: string[];
  rawTx?: VersionedTransactionResponse | undefined;
}

export interface SubscriptionHandlers {
  onSlot?: (slot: number) => void;
  onTransaction?: (tx: TxUpdate) => void;
  onPing?: () => void;
  onError?: (err: Error) => void;
  onEnd?: () => void;
}

/**
 * Decode a SubscribeUpdate's transaction field into a TxUpdate.
 * Returns null if the update has no transaction (e.g. it's a slot update).
 */
function projectTx(update: SubscribeUpdate): TxUpdate | null {
  const txWrap = update.transaction;
  if (!txWrap?.transaction) return null;
  const info = txWrap.transaction;

  const signature = info.signature ? bs58.encode(info.signature) : '';
  const slot = Number(txWrap.slot ?? 0);
  const isVote = info.isVote ?? false;

  const accountKeys = info.transaction?.message?.accountKeys ?? [];
  const rawAccountKeys = accountKeys.map((k) => bs58.encode(k));

  // Loaded addresses from address-table lookups extend the index space.
  const loadedWritable = info.meta?.loadedWritableAddresses ?? [];
  const loadedReadonly = info.meta?.loadedReadonlyAddresses ?? [];
  const allAccountKeys = [
    ...rawAccountKeys,
    ...loadedWritable.map((k) => bs58.encode(k)),
    ...loadedReadonly.map((k) => bs58.encode(k)),
  ];

  const instructions = info.transaction?.message?.instructions ?? [];
  const programIds = Array.from(
    new Set(
      instructions
        .map((ix) => allAccountKeys[ix.programIdIndex])
        .filter((k): k is string => Boolean(k)),
    ),
  );

  return {
    signature,
    slot,
    // Yellowstone gRPC transaction updates don't carry a block timestamp;
    // fall back to wall-clock receive time. ws-stream.ts uses
    // getTransaction() which returns the confirmed block time.
    blockTime: new Date().toISOString(),
    isVote,
    programIds,
    rawAccountKeys,
  };
}

/**
 * Wire stream events for slot + transaction updates. Returns a teardown
 * function that detaches the listeners (does not close the stream).
 */
export function attachStreamHandlers(
  stream: YellowstoneStream,
  handlers: SubscriptionHandlers,
  logger: Logger,
): () => void {
  const onData = (update: SubscribeUpdate) => {
    if (update.slot && handlers.onSlot) {
      handlers.onSlot(Number(update.slot.slot));
      return;
    }
    if (update.transaction && handlers.onTransaction) {
      const tx = projectTx(update);
      if (tx) handlers.onTransaction(tx);
      return;
    }
    if (update.ping) {
      handlers.onPing?.();
    }
  };

  const onError = (err: Error) => {
    logger.error({ err }, 'yellowstone stream error');
    handlers.onError?.(err);
  };

  const onEnd = () => {
    logger.warn('yellowstone stream ended');
    handlers.onEnd?.();
  };

  stream.on('data', onData);
  stream.on('error', onError);
  stream.on('end', onEnd);

  return () => {
    stream.off('data', onData);
    stream.off('error', onError);
    stream.off('end', onEnd);
  };
}
