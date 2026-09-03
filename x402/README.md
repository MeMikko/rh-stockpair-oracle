# Getting paid: two doors, and what each one is

**Bankr's x402 offering is a hosted gateway, not a facilitator.** Bankr
publishes the endpoint, issues the 402 itself, takes the USDC on Base, settles
it, and forwards the paid request to this origin. There is no public
`/verify` + `/settle` API for other people's servers, so "settle our own 402
through Bankr" is not a thing that exists — and pointing
`X402_FACILITATOR_URL` at Bankr would 402 every caller with an error about
signatures.

That leaves two doors, and they answer different callers. Both are live.

| Door | Who pays whom | What this origin does |
|---|---|---|
| **Bankr gateway** | caller → Bankr → us | trusts the shared secret, reads `x-402-payer`, serves |
| **Direct `exact`** | caller → this origin | verifies and settles through a standard open facilitator |

## Door 1: the Bankr gateway (`vates`)

```
https://x402.bankr.bot/0x4b19ee2a3de2521a3adc901989944c209c0a60ea/vates
        →  https://oracle.sb4s.xyz
```

Bankr forwards the request with two headers that matter:

| Header | Meaning |
|---|---|
| `x-402-payer` | the EVM address that paid, as Bankr settled it |
| `x-bankr-secret` | `VATES_BACKEND_SECRET`, as set on the gateway |

On this origin, set the same secret:

```
VATES_BACKEND_SECRET=<32+ random chars>
X402_GATEWAY_URL=https://x402.bankr.bot/0x4b19ee2a3de2521a3adc901989944c209c0a60ea/vates
```

**The secret is not optional here, and that is a deliberate departure from
"optional" in the gateway's own docs.** `x-402-payer` is a plain string: if a
request is trusted merely for carrying it, anyone can set it and walk through
the payment wall, and the wall becomes decoration. So this origin trusts a
gateway request only when the secret matches. With no secret configured there
is no trusted gateway path at all — in `launch` mode nothing changes, because
every route is served anyway, but the day `PRICING_MODE=paid` is flipped, an
unset secret means gateway callers get a 402 they cannot fix. `npm run
x402:check` and `GET /x402/supported` both report `trustedByOrigin` so this is
visible before it bites.

`X402_GATEWAY_URL` is documentation only — this process never calls it. It
appears in the 402 body and in `/.well-known/agent.json`, so a caller that
already pays through Bankr is told where to call instead of being left to
search a catalogue.

### What the payer address is used for

- **Usage accounting per payer.** `npm run usage` counts gateway traffic as
  `x402:0x…` rather than as one line for the gateway's IP, which is the one
  number a pricing decision needs. The address is not hashed: it is already a
  public identifier, and it is only ever read from a request whose secret
  matched.
- **The response says who it was served for**, in `x-oracle-payer`.
- It grants no entitlement. A pro period and prepaid credit are separate
  things, bought separately; a paid call is a paid call.

### Verifying the path end to end

The gateway is outside this repository, so the only honest check is a live
call. Two things to confirm once, after deploying:

```bash
# 1. the path survives the hop: /quote must arrive as /quote
curl -s 'https://x402.bankr.bot/0x4b19ee2a3de2521a3adc901989944c209c0a60ea/vates/quote?pool=0xPOOL'

# 2. the origin sees the headers it needs. In the API log, a served gateway
#    call is silent; a refused one says exactly why:
#      x402 gateway request refused: x-bankr-secret did not match
sudo journalctl -u rh-oracle-api -f | grep gateway
```

If the gateway does not preserve the path — everything landing on `/` — say so
and the routing shim belongs here rather than in guesswork: nothing in the
current code invents a route from a query parameter.

## Door 2: direct `exact`, through an open facilitator

For a caller that would rather pay `oracle.sb4s.xyz` than a gateway.
`X402_FACILITATOR_URL` must be a standard x402 facilitator — Coinbase's
production one at `https://x402.org/facilitator`, or any conforming service:

```bash
npm run x402:check                                   # what the configured one settles
npm run x402:check -- https://x402.org/facilitator   # try one without editing .env
```

Green means a standard client (`x402-fetch`, an app's `bankr.x402.fetch`) can
pay per call. Red means every signed authorization would be refused, and the
502/402 a caller sees would read as their problem rather than ours. Leaving it
unset is a supported state: the 402 then advertises the credit scheme and the
Bankr gateway, and says why `exact` is absent.
