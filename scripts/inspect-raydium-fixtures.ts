/**
 * Inspect Raydium fixture instruction data bytes.
 * Run: npx tsx --env-file=../.env inspect-raydium-fixtures.ts
 */
import { readFileSync } from 'node:fs';
import { PublicKey, VersionedTransaction } from '@solana/web3.js';

const AMM_V4 = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8';
const CLMM = 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK';

interface Fixture {
  response: {
    transaction: [string, string];
    meta: { loadedAddresses?: { writable: string[]; readonly: string[] }; logMessages?: string[] };
  };
}

function decodeFixture(path: string): void {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Fixture;
  const txBytes = Buffer.from(raw.response.transaction[0], 'base64');
  const vt = VersionedTransaction.deserialize(txBytes);
  const msg = vt.message;
  const staticKeys = msg.staticAccountKeys.map((k) => k.toBase58());
  const writable = raw.response.meta.loadedAddresses?.writable ?? [];
  const readonly = raw.response.meta.loadedAddresses?.readonly ?? [];
  const accountKeys = [...staticKeys, ...writable, ...readonly];

  for (const [i, ix] of msg.compiledInstructions.entries()) {
    const progId = accountKeys[ix.programIdIndex];
    const data = Buffer.from(ix.data);

    if (progId === AMM_V4) {
      console.log(`  [AMM v4 outer ix ${i}]`);
      console.log(`    instruction_code = data[0] = ${data[0]}`);
      console.log(`    data.len = ${data.length}`);
      console.log(`    data hex: ${data.toString('hex')}`);
      console.log(`    accounts count: ${ix.accountKeyIndexes.length}`);
      // AMM v4: user_source_token_account = index 14, user_destination = 15, signer = 16
      for (let ai = 0; ai < Math.min(ix.accountKeyIndexes.length, 20); ai++) {
        const acctKey = accountKeys[ix.accountKeyIndexes[ai] ?? -1];
        console.log(`    accounts[${ai.toString().padStart(2)}] = ${ix.accountKeyIndexes[ai]} → ${acctKey?.slice(0, 20)}`);
      }
    }

    if (progId === CLMM) {
      console.log(`  [CLMM outer ix ${i}]`);
      console.log(`    discriminator: ${data.slice(0, 8).toString('hex')}`);
      console.log(`    data.len = ${data.length}`);
      console.log(`    data hex: ${data.toString('hex')}`);
      console.log(`    accounts count: ${ix.accountKeyIndexes.length}`);
      for (let ai = 0; ai < Math.min(ix.accountKeyIndexes.length, 20); ai++) {
        const acctKey = accountKeys[ix.accountKeyIndexes[ai] ?? -1];
        console.log(`    accounts[${ai.toString().padStart(2)}] = ${ix.accountKeyIndexes[ai]} → ${acctKey?.slice(0, 20)}`);
      }
    }
  }
}

for (let i = 1; i <= 5; i++) {
  console.log(`\n=== AMM v4 fixture ${i} ===`);
  decodeFixture(`../packages/parser/tests/fixtures/raydium-amm-${i}.json`);
}

for (let i = 1; i <= 5; i++) {
  console.log(`\n=== CLMM fixture ${i} ===`);
  decodeFixture(`../packages/parser/tests/fixtures/raydium-clmm-${i}.json`);
}
