/**
 * Identify which Kamino instructions our 5 fixtures call by raw
 * discriminator (we'll match against the IDL once we fetch it in 2.9).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { VersionedTransaction } from '@solana/web3.js';

const KAMINO_LEND = 'KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD';
const FIXTURES_DIR = join(import.meta.dirname, '..', 'tests', 'fixtures');

function toHex(b: Uint8Array | number[]): string {
  let s = '';
  for (let i = 0; i < b.length; i++) s += (b[i] ?? 0).toString(16).padStart(2, '0');
  return s;
}

for (const name of ['kamino-1', 'kamino-2', 'kamino-3', 'kamino-4', 'kamino-5']) {
  const fx = JSON.parse(readFileSync(join(FIXTURES_DIR, `${name}.json`), 'utf-8')) as {
    response: {
      transaction: [string, string];
      meta?: { loadedAddresses?: { writable?: string[]; readonly?: string[] } };
    };
  };
  const txBytes = Buffer.from(fx.response.transaction[0], 'base64');
  const tx = VersionedTransaction.deserialize(txBytes);
  const staticKeys = tx.message.staticAccountKeys.map((k) => k.toBase58());
  const loadedW = fx.response.meta?.loadedAddresses?.writable ?? [];
  const loadedR = fx.response.meta?.loadedAddresses?.readonly ?? [];
  const allKeys = [...staticKeys, ...loadedW, ...loadedR];

  for (const ix of tx.message.compiledInstructions) {
    const pid = allKeys[ix.programIdIndex];
    if (pid !== KAMINO_LEND) continue;
    const disc = toHex(ix.data.slice(0, 8));
    console.log(`${name}: disc=${disc} data=${ix.data.length}B accounts=${ix.accountKeyIndexes.length}`);
  }
}
