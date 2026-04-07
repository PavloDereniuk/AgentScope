/**
 * Match the discriminators we observed in Kamino fixtures against
 * the freshly-fetched IDL so we know what instruction names the
 * 2.10 parser needs to support.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { VersionedTransaction } from '@solana/web3.js';
import idl from '../src/kamino/idl.json' with { type: 'json' };

const KAMINO_LEND = 'KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD';
const FIXTURES_DIR = join(import.meta.dirname, '..', 'tests', 'fixtures');

function toHex(b: Uint8Array | number[]): string {
  let s = '';
  for (let i = 0; i < b.length; i++) s += (b[i] ?? 0).toString(16).padStart(2, '0');
  return s;
}

function camelToSnake(name: string): string {
  return name.replace(/[A-Z]/g, (m) => '_' + m.toLowerCase()).replace(/^_/, '');
}

function anchorDiscriminator(snakeName: string): string {
  const hash = createHash('sha256').update(`global:${snakeName}`).digest();
  return toHex(hash.subarray(0, 8));
}

const discIdx = new Map<string, string>();
for (const ix of (idl as { instructions: { name: string }[] }).instructions) {
  // Try snake_case (anchor's canonical Rust name format)
  const snake = camelToSnake(ix.name);
  discIdx.set(anchorDiscriminator(snake), ix.name);
  // Also try the raw IDL name in case the program kept camelCase
  discIdx.set(anchorDiscriminator(ix.name), ix.name);
}

console.log(`IDL has ${discIdx.size} indexed instructions\n`);

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

  console.log(`=== ${name} ===`);
  for (const ix of tx.message.compiledInstructions) {
    const pid = allKeys[ix.programIdIndex];
    if (pid !== KAMINO_LEND) continue;
    const disc = toHex(ix.data.slice(0, 8));
    const ixName = discIdx.get(disc) ?? '???';
    console.log(`  ${ixName.padEnd(40)} disc=${disc} data=${ix.data.length}B`);
  }
  console.log();
}
