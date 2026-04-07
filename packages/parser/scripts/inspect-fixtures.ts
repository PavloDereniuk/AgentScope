/**
 * Debug helper: list which Jupiter instruction discriminators each
 * fixture exercises. Used to understand why some fixture tests fail
 * when the parser doesn't recognize a particular swap variant.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { VersionedTransaction } from '@solana/web3.js';
import idl from '../src/jupiter/idl.json' with { type: 'json' };

const JUP = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
const FIXTURES_DIR = join(import.meta.dirname, '..', 'tests', 'fixtures');

function toHex(b: Uint8Array | number[]): string {
  let s = '';
  for (let i = 0; i < b.length; i++) s += (b[i] ?? 0).toString(16).padStart(2, '0');
  return s;
}

const discIdx = new Map<string, string>();
for (const ix of (idl as { instructions: { name: string; discriminator?: number[] }[] })
  .instructions) {
  if (ix.discriminator?.length === 8) {
    discIdx.set(toHex(ix.discriminator), ix.name);
  }
}

for (const name of [
  'jupiter-swap-1',
  'jupiter-swap-2',
  'jupiter-swap-3',
  'jupiter-swap-4',
  'jupiter-swap-5',
]) {
  const fx = JSON.parse(readFileSync(join(FIXTURES_DIR, `${name}.json`), 'utf-8')) as {
    response: { transaction: [string, string] };
  };
  const txBytes = Buffer.from(fx.response.transaction[0], 'base64');
  const tx = VersionedTransaction.deserialize(txBytes);
  const keys = tx.message.staticAccountKeys.map((k) => k.toBase58());

  for (const ix of tx.message.compiledInstructions) {
    const pid = keys[ix.programIdIndex];
    if (pid !== JUP) continue;
    const disc = toHex(ix.data.slice(0, 8));
    const ixName = discIdx.get(disc) ?? '???';
    console.log(`${name}: ${ixName.padEnd(40)} disc=${disc} data=${ix.data.length}B`);
  }
}
