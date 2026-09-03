# Project: Robinhood Chain Stock-Pair Oracle + Public Agent

## Goal
Build a useful, visible, open-source agent in the Bankr ecosystem. Adoption
comes first — success = other agents call it, Bankr/Long people notice it, and
the public feed says things nobody else can say.

**It is not a free service and must never be advertised as one.** Prices are
published from launch even though nothing is charged yet: $0.005 for index
reads, $0.01 for anything costing an upstream RPC round trip, `/health` and
`/coverage` free. Every priced response carries `x-oracle-price-usd`,
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
   - `GET /gas` – gas estimate for chain 4663, split into L2 and L1-data
     components. Nothing else covers RH gas today.
   - `GET /corporate-actions` – the published calendar joined to the indexed
     pool set. Both halves are public; nothing else joins them.
   - `GET /coverage` – which stock tokens have a Chainlink feed.
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
   x402 has two doors. Bankr's is a hosted **gateway** (not a facilitator, and
   it publishes none): `x402.bankr.bot/<wallet>/vates` fronts this origin,
   collects the USDC and forwards the request with `x-402-payer`, trusted only
   when `x-bankr-secret` matches `VATES_BACKEND_SECRET`. Direct callers pay the
   origin with scheme `exact` through a standard open facilitator
   (`X402_FACILITATOR_URL`). Charging still waits on `PRICING_MODE=paid`.

## Context you should know
- Stock tokens trade 24/5 on-chain; underlying market has hours. When the
  market is closed the on-chain spread widens. Corporate actions reprice
  every pool paired to that stock — NVDA's next dividend touches ~9,900.
- **v3 carries ~36% of stock-paired volume** (measured twice, two machines:
  36% and 37%). Four of the five largest stock-paired pools by 24h volume are
  v3. Any claim of full coverage that indexes v4 alone is false.
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
- **Two Bankr keys, never one.** The public API holds a gateway-only key
  (`BANKR_LLM_KEY`) and refuses to boot with `BANKR_API_KEY` present; the
  wallet-scoped key lives only in the operator panel (`npm run admin`), which
  binds loopback, is not published by Caddy, and gates on `ADMIN_ADDRESSES`
  with its own secret and its own signed message. `npm run bankr:scope`
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
5. ⬜ Set `VATES_BACKEND_SECRET` on both sides of the Bankr gateway, point
   `X402_FACILITATOR_URL` at a standard facilitator, confirm both with
   `npm run x402:check`, then flip `PRICING_MODE=paid`.

Target: first public post ready before the gas subsidy ends (late Sept 2026).
