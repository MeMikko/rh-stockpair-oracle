import { facilitatorConfigured, x402Config } from '../config/x402.js';
import {
  FacilitatorUnavailable, facilitatorSupported, supports,
} from '../src/payments/facilitator.js';
import { assetDomain } from '../src/payments/asset.js';
import { paymentConfig } from '../config/payments.js';
import { pricingMode } from '../config/pricing.js';
import { payment402Body } from '../src/api/x402.js';

/**
 * Ask the facilitator what it will actually settle.
 *
 * The same idea as `npm run bankr:scope`: the configuration says the `exact`
 * scheme is settled through Bankr, and that is a belief until something asks.
 * A facilitator that does not do `exact` on `base`, or a URL with a typo in
 * it, produces a 402 for every caller and an error message about signatures
 * rather than about configuration — so this asks before the callers do.
 *
 *   npm run x402:check
 *   npm run x402:check -- https://some.facilitator/x402   # try one first
 */

async function main(): Promise<void> {
  const override = process.argv[2]?.trim();
  if (override) {
    process.env.X402_FACILITATOR_URL = override;
    // The config snapshot is frozen at import, so say plainly which URL is
    // being tested rather than printing one and querying another.
    (x402Config as { facilitatorUrl: string }).facilitatorUrl = override.replace(/\/+$/, '');
  }

  console.log(`pricing mode:  ${pricingMode}${pricingMode === 'launch' ? ' (nothing is charged yet)' : ''}`);
  console.log(`network:       ${x402Config.network}`);
  console.log(`pay to:        ${paymentConfig.treasury}`);
  console.log(`asset:         ${paymentConfig.usdc} (USDC)`);

  const domain = await assetDomain();
  console.log(
    `EIP-712 domain: name="${domain.name}" version="${domain.version}" (${domain.source})`,
  );
  if (domain.source === 'fallback') {
    console.log(
      '  Could not read name()/version() off the token — Base RPC unreachable? The 402 will\n' +
        '  advertise the values above, and a client signing against them will be refused if\n' +
        '  the token disagrees. Fix BASE_RPC_URL, or pin X402_ASSET_NAME/X402_ASSET_VERSION.',
    );
  }

  if (!facilitatorConfigured()) {
    console.log(
      '\nX402_FACILITATOR_URL is not set, so the `exact` scheme is NOT advertised.\n' +
        'Standard x402 clients (x402-fetch, `bankr x402 call`) cannot pay this service;\n' +
        'only the transfer-and-credit scheme works. Set it to Bankr’s facilitator and\n' +
        're-run this check.',
    );
    process.exit(1);
  }

  console.log(`\nfacilitator:   ${x402Config.facilitatorUrl}`);
  let kinds;
  try {
    kinds = await facilitatorSupported();
  } catch (err) {
    console.log(
      `  UNREACHABLE — ${(err as Error).message}\n` +
        (err instanceof FacilitatorUnavailable
          ? '  Every priced call would answer 503 rather than take money it cannot settle.\n'
          : ''),
    );
    process.exit(1);
  }

  if (kinds.length === 0) {
    console.log('  answered /supported with no kinds at all. Nothing can be settled through it.');
    process.exit(1);
  }
  for (const k of kinds) {
    console.log(`  supports: ${k.scheme ?? '?'} on ${k.network ?? '?'} (x402 v${k.x402Version ?? '?'})`);
  }

  const ok = supports(kinds, 'exact', x402Config.network);
  console.log(
    ok
      ? `\nexact/${x402Config.network}: supported. Standard clients can pay this service.`
      : `\nexact/${x402Config.network}: NOT supported by this facilitator. Every signed\n` +
          'authorization would be refused. Point X402_FACILITATOR_URL at one that settles\n' +
          `exact on ${x402Config.network}, or change X402_NETWORK to something it does.`,
  );

  // What a caller would actually receive, so the operator sees the document
  // rather than trusting that it is right.
  console.log('\n402 body for /quote:');
  console.log(JSON.stringify(payment402Body('/quote', domain), null, 2));

  if (!ok) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
