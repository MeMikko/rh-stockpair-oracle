# Project: Robinhood Chain Stock-Pair Oracle + Public Agent

## Goal
Build a useful, visible, open-source agent in the Bankr ecosystem. Adoption
comes first — success = other agents call it, Bankr/Long people notice it, and
the public feed says things nobody else can say.

**It is not a free service and must never be advertised as one.** Billing has
been on since 2026-09-03 (`PRICING_MODE=paid`): **$0.02 for every priced
route**, `/health` and `/coverage` free. One price rather than tiers
because Bankr's gateway prices an endpoint, not a route -- a split it does not
honour would be a published price callers are not charged. Every priced response carries `x-oracle-price-usd`,
`x-oracle-charged-usd` and `x-oracle-pricing`. "Free forever" is a promise that
would have to be broken, so it is never made. Prices cover upstream cost rather
than earn margin; see `config/pricing.ts`.

## What it is
1. **Data layer** – indexes every pool on Robinhood Chain (chain id 4663,
   Arbitrum Orbit L2) where one side is a tokenized stock/ETF (NVDA, AAPL,
   TSLA, ...). **Uniswap v4 AND v3**, from each contract's creation block.
   Covers Bankr-launched pools, Long pools, and any other launchpad, because
   discovery keys off `PoolManager.Initialize` and the v3 factory's
   `PoolCreated` rather than off any launchpad. Not Bankr-only.
2. **Endpoints** (deterministic, no LLM in the data path):
   - `GET /quote` – implied USD price of the paired token, pool depth,
     price impact for a given size, deviation vs Chainlink stock price,
     is-underlying-market-open flag, next corporate action on the pricing
     asset (split, dividend, ticker change).
   - `POST /prepare-swap` – ready-to-sign calldata, router address,
     min-out with slippage. Never sends transactions. Single-hop only.
     Both protocols: UniversalRouter + Permit2 for v4, the v3 router with one
     plain ERC-20 approval for v3. Which v3 router is deployed is read off the
     chain (`factoryV2()`), never assumed -- the two variants' structs differ
     by a field, so the selectors differ, and half-correct calldata is worse
     than none.
   - `GET /gas` – gas estimate for chain 4663, split into L2 and L1-data
     components. Nothing else covers RH gas today.
   - `GET /corporate-actions` – the published calendar joined to the indexed
     pool set. Both halves are public; nothing else joins them.
   - `GET /coverage` – which stock tokens have a Chainlink feed.
   - `GET /trades` – the largest recorded trades per stock. Costs no extra RPC
     call: the volume measurement already reads every Swap log and used to fold
     them into a sum and drop them.
   - `GET /history` – what was recorded, not what is read now: the price
     series for a stock's busiest pool and the drift against Chainlink split
     by market session. The only endpoint here a competitor cannot match by
     being cleverer — the public RPC has no archive, so nobody can start today
     and produce last week. A sweep that does not run is a gap nobody can fill.
     `/health` publishes the depth free, so a caller checks before paying.
   - `POST /ask` – free text in, structured answer out, with the facts behind
     it and the call that reproduces it. Keyword intent matching over a closed
     set; no model in this path either.
3. **Public agent** – a named account on Farcaster (via Neynar) and X that
   posts ONLY when the data says something notable, and answers questions put
   to it. Rare, data-backed posts. Text drafted via Bankr LLM Gateway
   (https://llm.bankr.bot, Anthropic-format API), never the facts.
   **Human approval for every post and every reply**, until told otherwise.
4. **Distribution** – deployed at https://oracle.sb4s.xyz; PR to
   https://github.com/BankrBot/skills with a SKILL.md + catalog.json pending.
   The RH category in that catalog holds only `hoodmarkets` and `rhagent`.
   x402 has two doors. Bankr's is a hosted **gateway** — measured 2026-09-03 as
   a path-preserving reverse proxy (x402 v2, `eip155:8453`) with its 402 over
   the whole path space, which is why `/health` and `/coverage` cost $0.02
   *through it* and are free at the origin; Bankr cannot exclude paths or price
   them separately, so a free route reached through the gateway answers with
   `freeAtOrigin` naming the URL where it costs nothing.
   `x402.bankr.bot/<wallet>/vates` fronts this origin,
   collects the USDC and forwards the request with `x-402-payer`, trusted only
   when `x-bankr-secret` matches `VATES_BACKEND_SECRET`. Direct callers pay the
   origin with scheme `exact` through a standard open facilitator
   (`X402_FACILITATOR_URL`). Charging still waits on `PRICING_MODE=paid`.

## Context you should know
- Stock tokens trade 24/5 on-chain; underlying market has hours. When the
  market is closed the on-chain spread widens. Corporate actions reprice
  every pool paired to that stock — NVDA's next dividend touches ~9,900.
- **v3 carries 36-42% of stock-paired volume by priced USD** (measured three
  times: 37% and 36% on 2026-09-02, 41.7% on 2026-09-05). By swap count it is
  30.8%, so any single figure must say which it counts. Four of the five
  largest stock-paired pools by 24h volume are v3. Any claim of full coverage
  that indexes v4 alone is false.
- Bankr's own agent confirmed: nothing exists for stock-paired pricing,
  Chainlink deviation, market-hours status, or corporate-action feeds on RH.
  Agents also lack RH calldata helpers and an RH gas estimator.
- **Do not compare our volume figures to Bankr's published $1.57M/day.**
  Different denominators, and the residual is unexplained even after
  narrowing to the Bankr Doppler hook. See the README.

## Do NOT build
- Rug/scam/bundle scoring (already exists, incl. for RH:
  x402.bankr.bot/.../bundles at $0.10/call; WAKE, delu, BlueAgent on Base).
- Generic token price/security scanners, Polymarket arb, PnL signal feeds.
- Anything that auto-sends transactions or holds user funds.

## Stack
TypeScript / Node 22+ (node:sqlite, `--env-file-if-exists`), viem, SQLite,
Fastify. Deployed on a shared Hetzner box as systemd units behind a
containerised Caddy — see `docs/DEPLOY.md`. Foundry only if a contract becomes
necessary (none planned).

## Rules
- Deterministic data path. LLM only for phrasing something already established.
- No private keys or API keys in the repo. `.env.example` only.
- Every published claim — post, reply, or `/ask` answer — must be reproducible
  by its reader, and `verifyDraft` enforces it: text may only contain numbers
  present in the signal's facts.
- `reproduce` must name something the *caller* can run, not the operator.
- Keep the README honest about what is estimated vs measured, and record what
  did not reconcile rather than dropping it.
- **A recorded price is not automatically evidence.** `quote_snapshots` stores
  the raw sqrtPriceX96 next to the derived price, and flags a sample that moved
  10%+ from the one before it within 20 minutes — on an AMM that is a real
  trade, but one large enough relative to depth that the price describes that
  order rather than a market. Flagged samples are counted separately and never
  averaged into a published statistic. Inherited from HoodGrow, which learned
  it 60 days late and could not re-judge its own history because it had kept
  only the derived number; `npm run flag:prices` re-derives every flag, which
  is the part that was missing there.
- **Two Bankr keys, never one.** The public API holds a gateway-only key
  (`BANKR_LLM_KEY`) and refuses to boot with `BANKR_API_KEY` present; the
  wallet-scoped key lives only in the operator panel (`npm run admin`), which
  gates on `ADMIN_ADDRESSES` with its own secret and its own signed message.
  The panel binds loopback by default; `ADMIN_ALLOW_REMOTE=1` publishes it at
  `admin.sb4s.xyz` and, in the same switch, forces Secure cookies, cuts the
  session to 2h, rate limits the sign-in routes, stops the sign-in error
  naming owners, and raises the secret floor to 32 chars. Published, the
  signature gate is the ONLY gate — see docs/DEPLOY.md. `npm run bankr:scope`
  verifies the split against Bankr rather than against memory.
- The agent has a wallet of its own; callers' funds are never touched. Say the
  precise thing — "never holds *your* funds" — not the flattering one.

## Resolved (was: unknowns)
- RPC `rpc.mainnet.chain.robinhood.com` (logs; no range cap, ~10k result cap,
  no archive) and Alchemy (state/archive; free tier caps `eth_getLogs` at 10
  blocks). Explorer: `robinhoodchain.blockscout.com`.
- Uniswap **both** v4 (PoolManager 0x8366a3…, block 9,070) and v3
  (factory 0x1f7d75…, block 8,930).
- Launchpad addresses were never needed — discovery is hook-agnostic.
- 194 stock tokens, 35 with Chainlink feeds, from the published registries.

## Phases
1. ✅ Indexer + `/quote` (implied USD, depth, deviation, market-open).
2. ✅ `/prepare-swap` + `/gas`.
3. ✅ Corporate-action calendar + public agent with approval queue.
4. ✅ Deployment + skill package. ⬜ skills-repo PR.
5. ✅ `VATES_BACKEND_SECRET` set on both sides, verified end to end (a forged
   secret gets 402, the real one 200), and `PRICING_MODE=paid` since
   2026-09-03. `X402_FACILITATOR_URL` is deliberately **empty**: measured
   2026-09-03, x402.org settles `exact` on testnets only, api.bankr.bot has no
   `/supported`, and Coinbase CDP needs a key. The origin now asks
   `/supported` before advertising `exact`, so an empty setting means the
   scheme is honestly absent rather than promised and refused. Paying works
   through the Bankr gateway and through prepaid credit; set the facilitator
   the day `npm run x402:check -- <url>` finds one that settles `exact` on
   Base, and `exact` turns itself back on.

6. ⬜ Retention is live (`rh-oracle-sample.timer`, every 15min). The series is
   worthless until it is long: `detectClosedMarketDrift` publishes nothing
   below 12 samples a side, and `/ask` says it has not recorded enough rather
   than reading a slope into four readings. Next: reach, not features — an MCP
   server over the same endpoints is the cheapest order-of-magnitude in
   callers, and can be built any day; retention could not wait, because every
   day without it is a day nobody can reconstruct.

Target: first public post ready before the gas subsidy ends (late Sept 2026).
