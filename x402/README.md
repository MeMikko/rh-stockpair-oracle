# The oracle on Bankr x402 Cloud

Two ways to pay this service exist, and they are not alternatives — they answer
different callers.

**Through Bankr's gateway.** `x402/vates` is a handler Bankr hosts, prices and
settles. Bankr issues the 402, takes the USDC on Base, settles it, and only
then runs the handler, which forwards the paid request to
`https://oracle.sb4s.xyz`. The reason to run it is discovery: an agent that
already pays for things through Bankr finds the endpoint in Bankr's catalogue —
and in `bankr x402 search` — without ever having heard of this service.

Live at:

```
https://x402.bankr.bot/0x4b19ee2a3de2521a3adc901989944c209c0a60ea/vates
```

**Direct, scheme `exact`.** `oracle.sb4s.xyz` also speaks the published protocol
itself: a caller signs an EIP-3009 authorization, sends it in `X-PAYMENT` (or
`PAYMENT-SIGNATURE`), and the origin verifies and settles it through whatever
facilitator `X402_FACILITATOR_URL` names. Nothing in this directory is involved.
See `config/x402.ts` and `npm run x402:check`.

## Deploying the handler

```bash
bankr x402 env set VATES_BACKEND_SECRET=<the same value as the origin's .env>
bankr x402 env set ORACLE_ORIGIN=https://oracle.sb4s.xyz
bankr x402 deploy vates
```

`bankr.x402.json` at the repo root carries the price ($0.02), the accepted
methods, and the input/output schema. The schema is not decoration: it is what
`bankr x402 call -i` prompts from and what an agent reads to call the endpoint
correctly without an integration written for it.

Check what a caller sees before trusting it:

```bash
bankr x402 schema https://x402.bankr.bot/0x4b19…60ea/vates
bankr x402 call   https://x402.bankr.bot/0x4b19…60ea/vates -i
```

## One endpoint, one route parameter

Bankr addresses one endpoint rather than a path space, so the oracle route
travels as a query parameter:

```
?route=/quote&pool=0x…&size=1000
?route=/pools&symbol=NVDA
?route=/ask            (POST, body {"question": "…"})
```

Anything not in the handler's allowlist is refused before the origin is called.

## The shared secret, and why it is not optional here

Bankr forwards `x-402-payer` — the wallet that actually paid, with any
caller-supplied value stripped by its router. That stripping happens on Bankr's
side; on this origin the header is a plain string anyone can set. Trusting it
because it is present would make the payment wall decoration: set the header,
skip the payment.

So the origin trusts a gateway request only when `x-bankr-secret` matches its
own `VATES_BACKEND_SECRET`. Set the same value on both sides:

```bash
# on the origin
VATES_BACKEND_SECRET=<32+ random chars>          # npm run secrets generates one

# on the endpoint
bankr x402 env set VATES_BACKEND_SECRET=<same>
```

Bankr's docs call the secret optional. Here it is not: with it unset there is
no trusted gateway path at all, which is harmless while `PRICING_MODE=launch`
and a 402 that gateway callers cannot fix once billing is on. `GET
/x402/supported` reports whether the origin can currently tell a gateway
request from a forgery.

Traffic that arrives this way is counted in `npm run usage` under the payer's
own address, so the share of demand coming through Bankr is visible rather than
merged into the direct traffic.

## One handler, one price — and what that keeps out

Bankr prices an endpoint, not a route. That is why the origin now charges one
figure — $0.02 — for every priced route rather than the two tiers it used to
publish: a split the gateway cannot express would be a published price callers
are not charged.

The same fact is why **`/health` and `/coverage` are not proxied at all**. They
are free at the origin, and one price for the endpoint would mean selling them
for $0.02 — charging for the two things this service gives away. The handler
refuses them with the direct URL instead:

```
https://oracle.sb4s.xyz/health      index freshness, cursors with lag in seconds
https://oracle.sb4s.xyz/coverage    which of the 194 stock tokens have a feed
```

Being refused costs nothing. Bankr settles only on a response under 400, so the
refusal is a free answer that names where to look — not a paid error.

## Costs

Bankr's first 1,000 settled requests each month are free; after that the
platform fee is 5% of the settled amount. Only settled requests count — a 402,
a handler error, and a paused endpoint are all free. The handler's compute,
storage and logs are included.
