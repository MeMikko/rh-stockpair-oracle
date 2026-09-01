import { getClient } from '../config/chain.js';
import { V4, V3, ROUTER, TOKENS, MISC } from '../config/addresses.js';
import type { Address } from 'viem';

/**
 * Every address in config/addresses.ts came from documentation. Documentation
 * drifts; bytecode does not. CI runs this so a silent address change surfaces
 * as a build failure rather than as wrong quotes.
 */
const groups = { V4, V3, ROUTER, TOKENS, MISC } as Record<string, Record<string, string>>;

const client = getClient();
let failures = 0;

const chainId = await client.getChainId();
if (chainId !== 4663) {
  console.error(`FAIL chainId: expected 4663, got ${chainId}`);
  process.exit(1);
}
console.log(`chainId 4663 ok | block ${await client.getBlockNumber()}\n`);

for (const [group, entries] of Object.entries(groups)) {
  console.log(group);
  for (const [name, addr] of Object.entries(entries)) {
    const code = await client.getCode({ address: addr as Address }).catch(() => undefined);
    const bytes = code && code !== '0x' ? (code.length - 2) / 2 : 0;
    const ok = bytes > 0;
    if (!ok) failures++;
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name.padEnd(20)} ${addr} ${bytes} bytes`);
  }
}

console.log(failures === 0 ? '\nall addresses live' : `\n${failures} address(es) with no bytecode`);
process.exit(failures === 0 ? 0 : 1);
