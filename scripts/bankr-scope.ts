import { bankr, adminKeyConfigured, llmConfigured } from '../config/bankr.js';
import { probeSigning } from '../src/bankr/client.js';

/**
 * Check what each Bankr key can actually do.
 *
 * The capability flags live in someone else's dashboard, so "the LLM key is
 * gateway-only" is a belief until something asks. This asks: it sends a
 * `personal_sign` request, which moves nothing and is refused with 403 by a
 * key that cannot sign. A 200 means the key on the public box can sign, and
 * the separation the deployment assumes does not exist.
 *
 *   npm run bankr:scope
 */

const label = (name: string, key: string): string =>
  `${name} (${key.slice(0, 8)}…${key.slice(-4)})`;

async function main(): Promise<void> {
  console.log(`Bankr API: ${bankr.apiBaseUrl}`);
  console.log(`LLM gateway: ${bankr.llmBaseUrl}\n`);

  let failed = false;

  if (!llmConfigured()) {
    console.log('BANKR_LLM_KEY is not set here — nothing to check for the public server.');
  } else {
    const res = await probeSigning(bankr.llmKey);
    if (res.status === 0) {
      console.log(`${label('LLM key', bankr.llmKey)}: could not reach Bankr — ${res.detail}`);
    } else if (res.canSign) {
      failed = true;
      console.log(
        `${label('LLM key', bankr.llmKey)}: CAN SIGN (HTTP ${res.status}).\n` +
          '  This key is not gateway-only. The public server attaches it to requests\n' +
          '  carrying caller-supplied text, so rotate it: generate a key at\n' +
          '  bankr.bot/api-keys with LLM Gateway enabled and wallet, agent and\n' +
          '  token-launch access off.',
      );
    } else {
      console.log(`${label('LLM key', bankr.llmKey)}: cannot sign (HTTP ${res.status}) — gateway-only, as intended.`);
    }
  }

  if (!adminKeyConfigured()) {
    console.log('\nBANKR_API_KEY is not set here. That is correct on the public box, and');
    console.log('wrong on the admin box — the panel needs it to read the wallet or launch.');
  } else {
    const res = await probeSigning(bankr.adminKey);
    console.log(
      `\n${label('admin key', bankr.adminKey)}: ${
        res.canSign
          ? `can sign (HTTP ${res.status}) — as the panel needs.`
          : `cannot sign (HTTP ${res.status}). Wallet API or read-write is off; the panel will be read-only.`
      }`,
    );
    if (!res.canSign) console.log(`  ${res.detail}`);
  }

  // A non-zero exit is what makes this usable from a deploy check.
  if (failed) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
