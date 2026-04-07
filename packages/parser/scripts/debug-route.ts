/**
 * Debug helper for jupiter route variant — print account resolution.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { VersionedTransaction } from '@solana/web3.js';
import idl from '../src/jupiter/idl.json' with { type: 'json' };

const FIXTURES_DIR = join(import.meta.dirname, '..', 'tests', 'fixtures');
const JUP = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';

const fx = JSON.parse(readFileSync(join(FIXTURES_DIR, 'jupiter-swap-1.json'), 'utf-8')) as {
  response: {
    transaction: [string, string];
    meta: {
      preTokenBalances?: { accountIndex: number; mint: string }[];
      postTokenBalances?: { accountIndex: number; mint: string }[];
      loadedAddresses?: { writable: string[]; readonly: string[] };
    };
  };
};

const txBytes = Buffer.from(fx.response.transaction[0], 'base64');
const tx = VersionedTransaction.deserialize(txBytes);

const staticKeys = tx.message.staticAccountKeys.map((k) => k.toBase58());
const loadedW = fx.response.meta.loadedAddresses?.writable ?? [];
const loadedR = fx.response.meta.loadedAddresses?.readonly ?? [];
const allKeys = [...staticKeys, ...loadedW, ...loadedR];

console.log('total accountKeys:', allKeys.length, '(static:', staticKeys.length, '+ writable:', loadedW.length, '+ readonly:', loadedR.length, ')');

interface BalEntry { accountIndex: number; mint: string; owner?: string; uiTokenAmount?: { amount: string } }
console.log('\nsigner:', allKeys[0]);

const pre = (fx.response.meta.preTokenBalances ?? []) as unknown as BalEntry[];
const post = (fx.response.meta.postTokenBalances ?? []) as unknown as BalEntry[];
console.log('\npreTokenBalances:');
for (const b of pre) {
  console.log(`  idx=${b.accountIndex} mint=${b.mint.slice(0, 16)}... owner=${b.owner?.slice(0, 16)}... amt=${b.uiTokenAmount?.amount}`);
}
console.log('\npostTokenBalances:');
for (const b of post) {
  console.log(`  idx=${b.accountIndex} mint=${b.mint.slice(0, 16)}... owner=${b.owner?.slice(0, 16)}... amt=${b.uiTokenAmount?.amount}`);
}

const routeDef = (idl as { instructions: { name: string; accounts: { name: string }[] }[] }).instructions.find((i) => i.name === 'route');
console.log('\nroute account names:');
routeDef?.accounts.forEach((a, i) => console.log(`  ${i}. ${a.name}`));

for (const ix of tx.message.compiledInstructions) {
  const pid = allKeys[ix.programIdIndex];
  if (pid !== JUP) continue;
  console.log('\nroute instruction account indexes:', Array.from(ix.accountKeyIndexes));
  for (let i = 0; i < ix.accountKeyIndexes.length; i++) {
    const idx = ix.accountKeyIndexes[i];
    const accName = routeDef?.accounts[i]?.name ?? '?';
    console.log(`  pos ${i} (${accName}): keyIdx=${idx} → ${allKeys[idx ?? 0]?.slice(0, 16)}...`);
  }
}
