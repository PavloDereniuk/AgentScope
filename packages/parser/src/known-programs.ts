/**
 * Curated whitelist of well-known Solana program IDs.
 *
 * Two consumers, deliberately in one place:
 *   - the dispatcher, which uses the friendly name as the label for
 *     programs that have no dedicated parser ("Compute Budget" instead
 *     of "comp.unknown");
 *   - the `unknown_program_interaction` detector rule (A.9), which treats
 *     everything OUTSIDE this map as a program AgentScope cannot name.
 *
 * It lives in its own module (rather than inside `dispatcher.ts`) so the
 * detector can import the whitelist through the `./known-programs` subpath
 * without pulling in `@solana/web3.js` + Anchor via the parser barrel.
 *
 * Only IDs verified against each protocol's canonical source (IDL,
 * deployed program, or on-chain account owner) are included here. If
 * you add a new entry, cross-reference the protocol's own code or
 * docs — mis-labelled IDs are worse than no label because the UI
 * confidently lies, and because the detector would stop flagging a
 * program it can no longer vouch for.
 */
export const KNOWN_PROGRAMS: ReadonlyMap<string, string> = new Map([
  ['11111111111111111111111111111111', 'System'],
  ['ComputeBudget111111111111111111111111111111', 'Compute Budget'],
  ['TokenkegQfZFAhUJMRNbSL2vM5qTgaK5TxwQnEKL7aP', 'Token'],
  ['TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', 'Token-2022'],
  ['ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', 'Associated Token'],
  ['Memo1UhkJBfCvE3urwUn9vNyTxWVF2qB2nRF3NsKNFt6', 'Memo'],
  ['MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr', 'Memo'],
  ['Stake11111111111111111111111111111111111111', 'Stake'],
  ['Vote111111111111111111111111111111111111111', 'Vote'],
  // Address Lookup Table — referenced by every v0 transaction that uses
  // ALTs. Verified against the constant in @solana/web3.js (`AddressLookupTableProgram`).
  ['AddressLookupTab1e1111111111111111111111111', 'Address Lookup Table'],
  // Metaplex Bubblegum (compressed NFT mints/transfers). Verified against
  // the program address in metaplex-foundation/mpl-bubblegum (programs/bubblegum).
  ['BGUMAp9Gq7iTEuizy4pqaxsTyUCBK68MDfK752saRPUY', 'Bubblegum (cNFT)'],
  // SPL Account Compression — backs Bubblegum's Merkle-tree storage. Verified
  // against solana-program-library/account-compression/programs/account-compression.
  ['cmtDvXumGCrqC1Age74AVPhSRVXJMd8PJS91L8KbNCK', 'Account Compression'],
  // SPL Noop — used by Account Compression to emit log-only events. Verified
  // against solana-program-library/account-compression/programs/noop.
  ['noopb9bkMVfRPU8AsbpTUg8AQkHtKwMYZiFUjNRtMmV', 'SPL Noop'],
  // Metaplex Token Metadata — verified against the address constant in
  // metaplex-foundation/mpl-token-metadata.
  ['metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s', 'Token Metadata'],
  // Jupiter v6 — verified against packages/parser/src/jupiter/idl.json (address field)
  // and the constant in jupiter/parser.ts.
  ['JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', 'Jupiter v6'],
  // Kamino Lend — verified against packages/parser/src/kamino/parser.ts:KAMINO_LEND_PROGRAM_ID.
  ['KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD', 'Kamino Lend'],
  // Raydium AMM v4 — non-Anchor legacy AMM, instruction code in first data byte.
  // Verified against mainnet fixtures (packages/parser/src/raydium/idl.json).
  ['675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', 'Raydium AMM v4'],
  // Raydium CLMM — Anchor-based concentrated-liquidity MM.
  // swap_v2 discriminator: sha256("global:swap_v2")[..8] = 2b04ed0b1ac91e62.
  ['CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK', 'Raydium CLMM'],
  // Orca Whirlpools — Anchor-based CLMM. swap disc f8c69e91e17587c8, swap_v2 2b04ed0b1ac91e62.
  // Verified against mainnet fixtures (packages/parser/src/orca/idl.json).
  ['whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc', 'Orca Whirlpools'],
  // Marinade Finance liquid staking — Anchor-based. Verified against
  // docs.marinade.finance/developers/contract-addresses + live getAccountInfo,
  // NOT the address in an earlier roadmap draft (that one doesn't exist on mainnet).
  ['MarBmsSgKXdrN1egZf5sqe1TMai9K1rChYNDJgjq7aD', 'Marinade Finance'],
  // Drift v2 perpetuals — Anchor. Discriminators verified against the official
  // Drift IDL (on-chain v2.150.0 + github.com/drift-labs/protocol-v2 v2.162.0);
  // state PDA confirmed on-chain owned by the program. See src/drift/idl.json.
  ['dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH', 'Drift v2'],
]);

/**
 * True when `programId` is one of the curated well-known programs above.
 *
 * The detector's `unknown_program_interaction` rule (A.9) treats a `false`
 * here as "AgentScope cannot name this program" — the first half of its
 * first-contact test (the second half is the agent's own history).
 */
export function isKnownProgram(programId: string): boolean {
  return KNOWN_PROGRAMS.has(programId);
}
