# Robinhood Chain Stock-Pair Oracle

Pricing for Uniswap v4 pools on **Robinhood Chain (chain id 4663)** where one
side is a tokenized stock or ETF. Deterministic: no model sits in the data path.

Phases 1-3 are implemented: pool indexer, `GET /quote`, `POST /prepare-swap`, `GET /gas`, `GET /corporate-actions`, and a public agent with a human approval queue.

## Why this exists

On Robinhood Chain, launchpads pair new tokens against tokenized equities
(NVDA, AAPL, SPY, …) instead of against ETH. That makes the quote asset
something whose price moves on a market with opening hours, splits and
dividends. Nothing published today reads those pools and says what a token is
actually worth in dollars, or how far the pool has drifted from the equity's
oracle price while the underlying market is shut.

## What is measured vs estimated

The project rule is that every published claim be reproducible from an endpoint
response, so the endpoints label their own confidence.

| Field | Status | Source |
|---|---|---|
| `price.spotCurrency1PerCurrency0` | **measured** | `StateView.getSlot0` sqrtPriceX96 |
| `price.impliedUsdOfPairedToken` | **measured** when a feed exists, else `null` | pool spot × Chainlink |
| `impact.*` | **measured** | on-chain v4 `Quoter` simulation |
| `pool.liveLpFee` | **measured** | live `slot0`, correct for dynamic-fee pools |
| `oracle.deviation` | **measured** when computable, else `null` + reason | see below |
| `corporateAction.*` | **measured** | ERC-8056 `uiMultiplier` / `effectiveAt` |
| `market.*` | **computed** | exchange calendar, not a data feed |
| `depth.token0/token1` | **estimate** | active-tick liquidity only |
| `pair.decimals*` | `decimalsSource` says `registry`/`rpc`/`assumed` | `assumed` = `decimals()` reverted |

`depth` is the one number here that can mislead. It counts only liquidity in the
active tick range, so a pool can report meaningful depth and still fail to fill a
small order — the quoter will say `NotEnoughLiquidity` while `depth` looks fine.
Trust `impact`, not `depth`.

## Two facts that shape the design

**Most stock tokens have no oracle.** 194 canonical stock tokens exist on chain
4663; 35 have a Chainlink feed. For the other 159 a Chainlink deviation is not
merely absent, it is *unknowable* — so `/quote` returns
`deviation: null` with an explicit `deviationReason` rather than omitting the
field. `GET /coverage` publishes the split.

**Deviation is only computable when the other side has a USD reference.** A
memecoin/NVDA pool tells you about the memecoin, not about NVDA. Deviation is
therefore computed only for stock/USDG and stock/stock pools; everything else
returns a reason (`paired_token_has_no_usd_reference`). No number is invented.

## Setup

```bash
npm install
cp .env.example .env      # add an Alchemy key -- see the RPC note below
npm run verify:addresses  # asserts every configured address still has bytecode
npm run registry:sync     # 194 stock tokens + 35 Chainlink feeds
npm run index:backfill    # PoolManager Initialize events -> pools
npm run serve
```

```bash
curl 'localhost:8080/quote?pool=<v4PoolId>&size=1000'
curl 'localhost:8080/coverage'
```

### The RPC note

The public endpoint (`rpc.mainnet.chain.robinhood.com`) caps `eth_getLogs`
near 1000 blocks, times out server-side on ranges it nominally accepts, and
rate-limits to 429 under sustained load. The backfill copes — it halves its
span on failure down to 25 blocks and grows back on success — but the chain tip
is past block 52,000,000 and a real backfill on the public endpoint is not
practical. Set `RH_RPC_URL` to a dedicated endpoint; Alchemy is Robinhood's
recommended provider.

## Design notes

**Hook-agnostic indexing.** Pools are discovered from `PoolManager.Initialize`
alone, never per-launchpad. Bankr (via Doppler), Uniswap's own launchpad, PAIR,
LONG and others all appear as different hook addresses in the same event
stream, so a new launchpad needs no code change. `HOOK_LABELS` supplies a human
label where we know one; unknown hooks are expected and fine.

**Fees are not standard tiers.** Observed live: the v4 dynamic-fee flag
(`0x800000`) on a large share of stock-paired pools, plus static values like
`831310`, `890000` and `981310`. Anything assuming 500/3000/10000 is silently
wrong, so fee comes from the event and, for dynamic pools, from live `slot0`.

**Corporate actions: announced off-chain, applied on-chain.** Stock tokens
implement ERC-8056, so splits and dividends land as `uiMultiplier` changes with
an `effectiveAt` timestamp rather than as a rebase — and `/quote` reads that
state directly per pool. Discovery is the other half: the multiplier only moves
when the action takes effect, which is too late to warn anyone, so the forward
calendar comes from Robinhood's published feed (see Phase 3 notes). Per
Robinhood's docs the Chainlink feed already returns the multiplier-adjusted
value, so the USD path never applies the multiplier a second time — it is
surfaced in the response so a consumer can check that assumption.

**PoolId is verified, not trusted.** Every indexed pool has its id recomputed
from the PoolKey and asserted against the event. A mismatch throws, because a
wrong PoolKey would produce confidently wrong quotes.

## Status

- [x] Phase 1 — indexer + `/quote` + `/coverage`
- [x] Phase 2 — `/prepare-swap` + `/gas`
- [x] Phase 3 — corporate-action calendar + public agent with approval queue
- [ ] Phase 4 — x402 Cloud deploy, skills-repo PR

Never sends transactions and never holds funds.

## Phase 2 notes

### `POST /prepare-swap`

Returns unsigned UniversalRouter calldata. It never signs, never broadcasts and
holds no keys.

```bash
curl -X POST localhost:8080/prepare-swap -H 'content-type: application/json' \
  -d '{"pool":"0x01c4…e7db","amountIn":"10000000000000000","zeroForOne":true,"slippageBps":50}'
```

`minOut` is derived from the on-chain quoter and then floored by
`applySlippage`, never from spot price — for these pools the hook and the live
dynamic fee both move the real output. If the quoter cannot price the swap the
endpoint returns **422 and no calldata**: handing back a transaction whose
output cannot be bounded is the one failure mode worth refusing outright.

```json
{ "error": "cannot quote this swap; refusing to emit calldata without a min-out",
  "reason": "NotEnoughLiquidity(0xd155…61e6)", "fromHook": true }
```

ERC-20 inputs list the two approvals Uniswap requires (token→Permit2, then
Permit2→router); native input lists none.

### The UniversalRouter is standard for single-hop, and isn't for multi-hop

A claim was circulating that Robinhood's UniversalRouter is a fork whose v4
swap struct carries an extra `minHopPriceX36`, making stock Uniswap SDK
calldata revert. We checked it against live transactions rather than take
either side on trust:

- `execute` has the standard selector `0x3593564c`.
- **Single-hop** `SWAP_EXACT_IN_SINGLE` is standard. Our encoder reproduces a
  real on-chain swap byte for byte — see `test/encode.test.ts`, which pins the
  params blob from tx `0x30d6b2e6…d58a`.
- **Multi-hop** `SWAP_EXACT_IN` is *not* standard: `ExactInputParams` carries
  one extra dynamic field between `path` and `amountIn` that upstream
  v4-periphery does not have. It was empty in all 14 live samples we decoded,
  so its type cannot be determined from the wire.

So the rumour was directionally right and specifically wrong: the difference is
real, but it is a struct-level field rather than a per-hop one, and single-hop
is unaffected. `/prepare-swap` therefore emits single-hop only — which is what
a stock-paired quote needs anyway — and multi-hop stays unimplemented until
that field's type can be confirmed from a non-empty instance.

### `GET /gas`

Nothing else publishes gas for chain 4663. Values come from the Nitro
`ArbGasInfo` precompile, and `?to=&data=` splits a specific call into its L2 and
L1-data components via `NodeInterface.gasEstimateComponents` — plain
`eth_estimateGas` folds the two together and hides exactly the number that will
change when the subsidy lapses.

The subsidy flag is **measured, not assumed from a date**, and it is measured
across a window rather than from one read. As of 2026-09-01 `perL1CalldataUnit`
and `getL1BaseFeeEstimate` are both `0`, and a plain transfer estimates 21,000
gas with `gasForL1: 0` — about 0.000007 ETH. Congestion is currently ~94% of
the gas price (`312692000` of `332692000` wei), with the floor at `20000000`.

**Why the window matters.** During testing the instantaneous L1 reading went
non-zero (a transfer estimated 21,186 gas with `gasForL1: 21`) and reverted to
zero minutes later. A naive one-sample flag would have reported the subsidy as
ended — precisely the false claim the Phase 3 agent must never post. `/gas`
therefore keeps a rolling sample log and only sets `l1DataFreeNow` when *every*
retained sample is zero; `subsidy.evidence` exposes the sample count, window
length and last non-zero observation so a caller can judge for itself.

Gas estimation executes the call, so a swap estimate needs a `from` that
actually holds and has approved the token; without one the response explains
that rather than reporting an opaque revert.

## Phase 3 notes

### `GET /corporate-actions`

The calendar joined to the indexed pool set. Both halves are public; nothing
else joins them — which is the point. On this chain a dividend or split is
applied through the ERC-8056 `uiMultiplier`, so every pool quoted in that stock
reprices at once.

```bash
curl 'localhost:8080/corporate-actions?withinDays=30&onlyAffecting=true'
```

Source is Robinhood's published `/rhj/corporate-actions`, not reconstructed from
chain events: `UIMultiplierUpdated` only fires when the multiplier actually
changes, which is far too late to warn anyone, and sweeping 194 tokens for rare
events is not viable on the public RPC. On-chain `newUIMultiplier`/`effectiveAt`
confirm an action once staged; they don't discover it.

The ERC-8056 event signatures are taken from the spec, not inferred —
`UIMultiplierUpdated(uint256 oldMultiplier, uint256 newMultiplier, uint256
effectiveAtTimestamp)` takes three arguments, and an announced action can be
withdrawn via `UIMultiplierUpdateCancelled`, which a calendar has to reflect.

### The agent, and what stops it saying something false

The data path stays deterministic. A **signal** is an observation the code made
— an upcoming action touching N pools, the oracle coverage gap, a change in the
gas subsidy — and each carries its facts plus the endpoint call that reproduces
it. The model never decides *what* is true; it only phrases a signal that
already exists, and phrasing is optional (templates cover every signal kind, so
a missing API key degrades the prose, not the pipeline).

Between the model and any timeline sits `verifyDraft`: **a draft may only contain
numbers that appear in the signal's facts.** An invented pool count, a rounded
rate or a derived percentage fails the check and the model's text is discarded
in favour of the template, with the rejection reported rather than swallowed.
This is what makes "every posted claim is reproducible from an endpoint
response" enforceable instead of aspirational.

The check caught its first real case during development — on our own template,
which says "ERC-8056" and thus contained an `8056` that is not a fact. Standard
identifiers (`ERC-8056`, `v4`, `chain 4663`) are now stripped before the numeric
scan; a bare `8056` in a sentence about pool counts is still rejected, and there
are tests for both.

### Publishing is gated three ways

```bash
npm run agent:scan                  # detect signals, draft, queue as DRAFT
npm run agent:queue                 # review
npm run agent:approve -- <id>       # a person decides; the name is recorded
npm run agent:publish               # dry run by default
npm run agent:publish -- --live     # only now can anything be sent
```

Nothing is sent unless **all** of: the post is `approved`, credentials for the
channel exist, and `--live` was passed. The default is a dry run, so an
accidental invocation cannot reach a public timeline. One post per signal, so
re-scanning never duplicates; an already-decided post cannot be revived.

An approved post whose channel has no credentials is **skipped, not failed** —
it stays approved for a later run rather than burning something a person already
signed off on.

X is dry-run only: posting needs OAuth 1.0a request signing, and a half-signed
request that silently fails is worse than a channel that says it isn't wired up.
