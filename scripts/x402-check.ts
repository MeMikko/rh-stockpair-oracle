import {
  facilitatorConfigured, gatewayAdvertised, gatewayTrusted, x402Config,
} from '../config/x402.js';
import {
  FacilitatorUnavailable, facilitatorSupported, supports,
} from '../src/payments/facilitator.js';
import { assetDomain } from '../src/payments/asset.js';
import { paymentConfig } from '../config/payments.js';
import { pricingMode } from '../config/pricing.js';
import { payment402Body } from '../src/api/x402.js';

/**
 * Ask the facilitator what it will actually settle, and report both doors.
 *
 * The same idea as `npm run bankr:scope`: the configuration says a scheme is
 * settled somewhere, and that is a belief until something asks. A facilitator
 * that does not do `exact` on `base`, or a URL with a typo in it, produces a
 * 402 for every caller and an error message about signatures rather than
 * about configuration — so this asks before the callers do.
 *
 * The Bankr gateway is the other door and cannot be probed from here: it
 * fronts this origin rather than answering to it. What can be checked is
 * whether this origin would be able to tell a request from it apart from a
 * forgery, which is the part an operator forgets.
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
  console.log(
    `bankr gateway: ${
      gatewayAdvertised()
        ? `${x402Config.gateway.url}\n               ${
            gatewayTrusted()
              ? 'VATES_BACKEND_SECRET is set — a forwarded request can be trusted'
              : 'NO VATES_BACKEND_SECRET — gateway requests are refused in paid mode, ' +
                'because `x-402-payer` alone is a claim anyone can make'
          }`
        : 'not advertised (X402_GATEWAY_URL unset)'
    }`,
  );
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
      '\nX402_FACILITATOR_URL is not set, so the `exact` scheme is NOT advertised on this\n' +
        'origin. A standard x402 client (x402-fetch) cannot pay us directly; the Bankr\n' +
        'gateway and the transfer-and-credit scheme still work. Set it to a standard open\n' +
        'facilitator — https://x402.org/facilitator — and re-run. NOT a Bankr URL: Bankr\n' +
        'publishes no /verify or /settle for other people’s servers.',
    );
    // Printed even here: the gateway may be the intended door, and the body a
    // caller receives is the thing worth reading either way.
    console.log('\n402 body for /quote:');
    console.log(JSON.stringify(payment402Body('/quote', domain), null, 2));
    // Not a failure when the gateway is the intended door: exiting non-zero
    // would fail a deploy check for a configuration that is deliberate.
    process.exit(gatewayTrusted() ? 0 : 1);
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
