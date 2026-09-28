/**
 * Highest transaction version every RPC fetch in the worker accepts.
 *
 * The RPC rejects the whole request when a transaction exceeds this —
 * for `getBlock` that means one newer tx in the slot fails the entire
 * block. v1 messages (compute budget in `transactionConfig`, no address
 * lookup tables) went live on mainnet in Sep 2026 and made up ~13% of a
 * sampled block, so leaving this at 0 silently dropped agent swaps and
 * starved the sandwich rule of slot neighbours. Requires
 * @solana/web3.js >= 1.99, which deserializes MessageV1.
 */
export const MAX_SUPPORTED_TX_VERSION = 1;
