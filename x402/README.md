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

## What is actually deployed, measured 2026-09-03

The gateway live at that URL is **not** the handler in this directory. It is a
path-preserving reverse proxy with a 402 in front of the whole path space:

```
$ curl -si https://x402.bankr.bot/0x4b19…60ea/vates/health
HTTP/2 402
{"x402Version":2,"accepts":[{"scheme":"exact","network":"eip155:8453",
  "maxAmountRequired":"20000","amount":"20000",
  "resource":"https://x402.bankr.bot/0x4b19…60ea/vates/health",
  "payTo":"0x8AEE…01a0","asset":"0x8335…2913"}],
 "facilitator":"https://api.bankr.bot/facilitator"}
```

Four things follow, and none of them were assumptions before this was run:

- **Routes travel as paths, not as `?route=`.** `…/vates/quote?pool=0x…` is the
  call. Every origin route is reachable under its own path, unchanged.
- **The price is already $0.02** (20000 base units), matching the origin.
- **It speaks x402 v2 and names Base in CAIP-2** (`eip155:8453`), where the
  origin's own door speaks v1 and `base`. Both are correct; they are different
  doors. It settles through `api.bankr.bot/facilitator`, which is Bankr's
  facilitator for Bankr's own endpoints and publishes no `/supported` (404 —
  see `.env.example`), so it is not a candidate for the origin's direct door.
- **`payTo` is Bankr's address**, not this service's treasury. Bankr collects
  and pays out to the wallet named in the gateway URL.

### The free routes are charged there, and cannot be un-charged here

`…/vates/health` and `…/vates/coverage` cost $0.02 through the gateway. This
origin cannot prevent it: Bankr settles before the request arrives, and there
is nothing here to refund. Excluding those two paths is a change on Bankr's
side, and until it is made, the honest thing is to say so — which is why the
skill and the catalogue now name the free direct URLs, and why a free route
reached through the gateway answers with

```
x-oracle-free-at-origin: https://oracle.sb4s.xyz/health
```

so a caller pays for that answer once rather than every time.

## The handler in this directory, and when it applies

`x402/vates/index.ts` and `bankr.x402.json` target `bankr x402 deploy` — Bankr
x402 Cloud, where Bankr hosts the code itself and addresses **one endpoint**
rather than a path space. There the route travels as a query parameter:

```
?route=/quote&pool=0x…&size=1000
?route=/pools&symbol=NVDA
?route=/ask            (POST, body {"question": "…"})
```

Anything not in the handler's allowlist is refused before the origin is called,
and `/health` and `/coverage` are refused for free with the direct URL instead.

That carve-out is real code and it works — but it does not run today, because
the gateway in front of this service is the proxy above, not this handler. Kept
because it is the shape the Cloud product takes and the two are one `bankr
x402 deploy` apart; not kept as a description of what is live.

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
