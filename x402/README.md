# The oracle on Bankr x402 Cloud

Two ways to pay this service exist, and they are not alternatives to each
other — they answer different callers.

**Direct, scheme `exact`.** `oracle.sb4s.xyz` speaks the published protocol
itself: a caller signs an EIP-3009 authorization, sends it in `X-PAYMENT`, and
the origin verifies and settles it through a facilitator. Any standard client
works — `x402-fetch`, `bankr x402 call`, an app's `bankr.x402.fetch`. Nothing
in this directory is involved. See `config/x402.ts` and `npm run x402:check`.

**Through Bankr's marketplace.** `x402/oracle/index.ts` is a handler Bankr
hosts, prices and settles. It forwards to the origin. The reason to run it is
discovery: an agent that pays for things through Bankr finds the endpoint in
Bankr's catalogue and calls it without ever having heard of this service.

## Deploying the handler

```bash
bankr x402 init                          # once, to see the scaffold it expects
bankr x402 deploy ./x402/oracle --price 0.01
```

The handler is written to the plain `Request` → `Response` shape. If the
scaffold the CLI generates differs, keep its wrapper and move the body across
rather than fighting it — the logic is thirty lines and none of it is Bankr
specific.

Set two environment variables on the deployed handler:

| Variable | Value |
|---|---|
| `ORACLE_ORIGIN` | `https://oracle.sb4s.xyz` |
| `ORACLE_SERVICE_KEY` | one of the origin's `X402_SERVICE_KEYS` secrets |

## The service key, and why it exists

Bankr collects the money before the call reaches the origin. Without a way to
say so, the origin would charge for it a second time — the caller pays Bankr,
the origin answers 402, and the endpoint is broken for everyone who found it
through the marketplace.

`x-oracle-service-key` is that signal. On the origin, set:

```
X402_SERVICE_KEYS=bankr-cloud:<32+ random chars>
```

It is a shared secret, not a caller credential:

- it skips per-call payment entirely, so it belongs only in the handler's
  environment;
- it is compared in constant time, and anything under 16 characters is ignored
  rather than accepted as a weak key;
- traffic carrying it is counted in `npm run usage` under `svc:…`, so the
  share of demand arriving through Bankr is visible rather than merged into
  the direct traffic.

Rotate it by adding a second entry (`X402_SERVICE_KEYS=old:…,new:…`),
redeploying the handler with the new value, then dropping the old one.

## One handler, one price

Bankr prices an endpoint. This service prices routes in two tiers — $0.005 for
an index read, $0.01 for anything that costs an upstream RPC round trip — so
one handler cannot express both. The handler is therefore deployed at $0.01
and covers every route.

If the cheap routes are worth selling cheaply, deploy a second handler with
`ROUTES` narrowed to `/ask`, `/pools`, `/volume` and `/corporate-actions` at
$0.005. Do not simply price everything at $0.005: a quoter simulation costs
several RPC calls to serve, and selling it below cost is how a service becomes
something its operator resents running.
