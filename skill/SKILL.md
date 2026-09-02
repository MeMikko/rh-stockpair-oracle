---
name: rh-stockpair-oracle
description: Pricing and corporate-action data for Robinhood Chain (4663) pools where one side is a tokenized stock or ETF. Implied USD price, pool depth, price impact, Chainlink deviation, is-the-underlying-market-open, upcoming splits and dividends, RH gas estimates, and unsigned swap calldata. Use for Robinhood Chain, chain 4663, stock-paired pools, NVDA/AAPL/TSLA/SPY tokens, tokenized equity pricing, RH gas, ERC-8056 multiplier, corporate actions on-chain. Covers Uniswap v4 AND v3 — v3 carries roughly a third of stock-paired volume.
tags: [robinhood, chain-4663, uniswap, oracle, stocks, corporate-actions, gas, defi]
version: 1
---

# RH stock-pair oracle

Pricing for **Robinhood Chain (4663)** pools where one side is a tokenized
stock or ETF. Deterministic: no model sits in the data path, and every response
carries the facts behind it.

**Base URL:** `https://REPLACE-ME.example.com`
**Source:** `https://github.com/MeMikko/rh-stockpair-oracle`

**Pricing.** This is not a free service. It is currently in **launch mode**:
every route is served without charge and no key is required, while each
response publishes what the call will cost once billing is enabled.

```
x-oracle-price-usd: 0.01     what this route will cost
x-oracle-charged-usd: 0      what it cost you today
x-oracle-pricing: launch     the current mode
```

Read those headers rather than assuming. Intended prices are $0.005 for index
reads (`/corporate-actions`, `/ask`) and $0.01 for anything that costs an
upstream RPC round trip (`/quote`, `/prepare-swap`, `/gas`). `/health` and
`/coverage` stay free. Prices are set to cover upstream cost, not to earn
margin — adoption is the goal.

## Why this exists

On Robinhood Chain, launchpads pair new tokens against tokenized equities
instead of against ETH. That makes the quote asset something whose price moves
on a market with opening hours, splits and dividends. Nothing else published
reads those pools and says what a token is actually worth in dollars, or how
far a pool has drifted from the equity's oracle price while the underlying
market is shut.

## What is covered

Both Uniswap deployments, from each contract's creation block to the tip:

| | v4 | v3 |
|---|---|---|
| Pools indexed | 570,744 | 425,837 |
| Stock-paired | 44,443 | 1,782 |
| Share of stock-paired volume | 63% | **37%** |

The v3 half matters more than its pool count suggests. Three of the five
largest stock-paired pools by 24h volume are v3, and the single most-traded by
swap count is a v3 NVDA/USDG pool. **An index that covers only v4 misses a
third of the subject**, which is what every other RH data source does today.

## Endpoints

All reads. Nothing here signs, broadcasts, or holds funds.

```
GET  /health                     index freshness: pool counts and cursors, both protocols
GET  /coverage                   which stock tokens have a Chainlink feed
GET  /quote?pool=<id>&size=<usd> implied USD, depth, price impact, deviation, market hours
POST /prepare-swap               unsigned UniversalRouter calldata with a bounded min-out
GET  /gas                        chain 4663 gas, split into L2 and L1-data components
GET  /corporate-actions          upcoming splits/dividends joined to the affected pools
POST /ask                        free-text question, structured answer
```

### `GET /quote`

```bash
curl 'https://REPLACE-ME.example.com/quote?pool=0x30e5…dced&size=1000'
```

Returns spot from `StateView.getSlot0`, implied USD of the paired token, price
impact simulated on the on-chain v4 `Quoter`, the live LP fee (correct for
dynamic-fee pools), deviation vs Chainlink, whether the underlying market is
open, and the next corporate action on the pricing asset.

**Read the labels.** The response says what is measured and what is estimated:

| Field | Status |
|---|---|
| `price.spot*`, `impact.*`, `pool.liveLpFee` | measured on-chain |
| `oracle.deviation` | measured, or `null` with an explicit `deviationReason` |
| `market.*` | computed from an exchange calendar, not a feed |
| `depth.token0/token1` | **estimate** — active-tick liquidity only |

`depth` is the one number that can mislead: a pool can report meaningful depth
and still fail to fill a small order. Trust `impact`, not `depth`.

### Deviation is often `null`, on purpose

194 canonical stock tokens exist on chain 4663; **35 have a Chainlink feed.**
For the other 159 a deviation is not merely absent, it is *unknowable*
on-chain. And deviation is only computable when the other side has its own USD
reference — a memecoin/NVDA pool tells you about the memecoin, not about NVDA.

So `/quote` returns `deviation: null` with a `deviationReason` rather than
inventing a number. `GET /coverage` publishes the split. Any consumer that
treats a missing deviation as zero is wrong.

### `POST /prepare-swap`

```bash
curl -X POST https://REPLACE-ME.example.com/prepare-swap \
  -H 'content-type: application/json' \
  -d '{"pool":"0x01c4…e7db","amountIn":"10000000000000000","zeroForOne":true,"slippageBps":50}'
```

Unsigned calldata for the UniversalRouter, plus the approvals an ERC-20 input
needs (token→Permit2, then Permit2→router). `minOut` comes from the on-chain
quoter and is then floored by slippage — never from spot price, because on
these pools the hook and the live dynamic fee both move the real output.

If the quoter cannot price the swap it returns **422 and no calldata**.
Handing back a transaction whose output cannot be bounded is the one failure
worth refusing outright.

**Single-hop only.** RH's UniversalRouter `execute` is standard
(`0x3593564c`) and single-hop `SWAP_EXACT_IN_SINGLE` reproduces a real on-chain
swap byte for byte. Multi-hop `ExactInputParams` carries one extra dynamic
field that upstream v4-periphery does not have; it was empty in all 14 live
samples decoded, so its type cannot be determined from the wire and multi-hop
stays unimplemented.

### `GET /gas`

Nothing else publishes gas for chain 4663. Values come from the Nitro
`ArbGasInfo` precompile; `?to=&data=` splits a specific call into L2 and
L1-data components via `NodeInterface.gasEstimateComponents` — plain
`eth_estimateGas` folds the two together and hides exactly the number that
changes when the launch subsidy lapses.

The subsidy flag is **measured across a window, not assumed from a date**. The
instantaneous L1 reading flaps: a non-zero observation during development
reverted to zero minutes later. `subsidy.evidence` exposes the sample count,
window length and last non-zero observation so a caller can judge for itself.

### `GET /corporate-actions`

```bash
curl 'https://REPLACE-ME.example.com/corporate-actions?withinDays=30&onlyAffecting=true'
```

The published calendar joined to the indexed pool set. Both halves are public;
nothing else joins them. On this chain a dividend or split applies through the
ERC-8056 `uiMultiplier`, so **every pool quoted in that stock reprices at
once** — NVDA's next dividend touches 9,669 indexed pools.

Discovery comes from the published feed, not from chain events:
`UIMultiplierUpdated` only fires when the multiplier actually changes, which is
far too late to warn anyone.

### `POST /ask`

```bash
curl -X POST https://REPLACE-ME.example.com/ask \
  -H 'content-type: application/json' \
  -d '{"question":"how many pools quote NVDA?"}'
```

```json
{ "answered": true, "intent": "pools", "symbol": "NVDA",
  "answer": "9669 indexed pools on Robinhood Chain quote NVDA (9228 on Uniswap v4, 441 on v3).",
  "facts": { "symbol": "NVDA", "v4Pools": 9228, "v3Pools": 441, "totalPools": 9669 },
  "reproduce": "GET /corporate-actions?symbol=NVDA" }
```

`facts` and `reproduce` are the point: **verify the answer rather than trust
it.** No model runs in this path — intent is keyword matching over a closed
set — so it is deterministic and safe to call in a loop.

A question it cannot classify returns `answered: false` and says what it does
know. There is no fallback that guesses.

## Agent guidance

- **Never treat `deviation: null` as zero.** Check `deviationReason`. Most
  stock tokens have no feed, and that is a fact about the chain, not an error.
- **Quote before you size.** `depth` is an active-tick estimate; `impact` is a
  simulation. Only `impact` tells you whether a trade fills.
- **Check `market.isOpen` before acting on a deviation.** Stock tokens trade
  24/5 on-chain while the underlying market has hours; a wide spread at 03:00
  ET is the normal state of the world, not a signal.
- **Check `/corporate-actions` before quoting a size in a stock-paired pool.**
  A multiplier change reprices every pool in that stock simultaneously.
- **`/prepare-swap` returns calldata, never a transaction.** Submit it through
  Bankr with `chainId: 4663` after your own validation. A 422 means the swap
  could not be bounded — do not construct calldata yourself to work around it.
- **Do not hardcode a price.** Read `x-oracle-price-usd` and
  `x-oracle-charged-usd` per response; launch mode will end.
- **Do not compare these volume figures to another dashboard's.** Denominators
  differ; see the repository README for the measured breakdown and the
  unreconciled residual against Bankr's published number.

## Limits

- `depth` is active-tick only, and is labelled as an estimate.
- Multi-hop `/prepare-swap` is unimplemented (see above).
- Volume figures are measured over a rolling 24h window and are refreshed
  every 6 hours, not live.
- 159 of 194 stock tokens have no Chainlink feed; for those, no deviation is
  computable by anyone.
