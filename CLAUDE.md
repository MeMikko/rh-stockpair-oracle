# Project: Robinhood Chain Stock-Pair Oracle + Public Agent

## Goal
Build a useful, visible, open-source agent in the Bankr ecosystem. The goal is
reputation and adoption, NOT revenue. Endpoints are free or near-free
(≤ $0.01 USDC via x402). Success = other agents call it, Bankr/Long people
notice it, and the public feed says things nobody else can say.

## What it is
1. **Data layer** – indexes every pool on Robinhood Chain (chain id 4663,
   Arbitrum Orbit L2, Uniswap is the dominant DEX) where one side is a
   tokenized stock/ETF (NVDA, AAPL, TSLA, ...). Covers Bankr-launched pools,
   Long pools, and any other launchpad. Not Bankr-only.
2. **Endpoints** (deterministic, no LLM in the data path):
   - `GET /quote` – implied USD price of the paired token, pool depth,
     price impact for a given size, deviation vs Chainlink stock price,
     is-underlying-market-open flag, next corporate action on the pricing
     asset (split, dividend, ticker change).
   - `POST /prepare-swap` – ready-to-sign calldata, router address,
     min-out with slippage. Never sends transactions.
   - `GET /gas` – gas estimate for chain 4663. Nothing else covers RH gas
     today. Relevant because the 90-day gas subsidy ends late Sept 2026.
3. **Public agent** – a named account on Farcaster (via Neynar) and X that
   posts ONLY when the data says something notable: large Chainlink
   deviation while market is closed, upcoming split affecting N pools,
   post-subsidy gas cost changes, etc. Rare, data-backed posts. Text drafted
   via Bankr LLM Gateway (https://llm.bankr.bot, Anthropic-format API).
   Human approval for every post until told otherwise.
4. **Distribution** – deploy endpoints on Bankr x402 Cloud, and open a PR
   to https://github.com/BankrBot/skills with a SKILL.md + catalog.json.
   The RH category in that catalog is empty except `hoodmarkets`.

## Context you should know
- Stock tokens trade 24/5 on-chain; underlying market has hours. When the
  market is closed the on-chain spread widens. Corporate actions reprice
  every pool paired to that stock.
- Bankr added stock-pairing for 90+ stock/ETF tokens on 2026-07-20. On
  Bankr-launched RH tokens, stock-paired pools are ~69% of daily volume and
  rising. Long (its AI/NVDA pair) is the chain's biggest volume source.
- Bankr's own agent confirmed: nothing exists for stock-paired pricing,
  Chainlink deviation, market-hours status, or corporate-action feeds on RH.
  Agents also lack RH calldata helpers and an RH gas estimator.
- Suggested x402 pricing from Bankr: $0.005–$0.02/call. We go free/$0.01.

## Do NOT build
- Rug/scam/bundle scoring (already exists, incl. for RH:
  x402.bankr.bot/.../bundles at $0.10/call; WAKE, delu, BlueAgent on Base).
- Generic token price/security scanners, Polymarket arb, PnL signal feeds.
- Anything that auto-sends transactions or holds user funds.

## Stack
TypeScript / Node 20+, viem, Postgres (or SQLite for v1), a small
Fastify/Express server, Bankr CLI for x402 deploy (handler is TypeScript).
Foundry only if a contract becomes necessary (none planned for v1).

## Rules
- Deterministic data path. LLM only for post text.
- No private keys or API keys in the repo. `.env.example` only.
- Fork/test against a local fork before touching mainnet RPC quotas.
- Every posted claim must be reproducible from an endpoint response.
- Keep the README honest about what is estimated vs measured.

## Unknowns to resolve FIRST (ask me if you cannot find them)
- Robinhood Chain public RPC URL and explorer.
- Uniswap deployment addresses on RH (which versions: v3? v4? both?).
- Bankr token factory / launch contract address on RH.
- Where Long's pool list is readable (contract registry or API).
- Verified stock/ETF token contract address list on RH.
- Chainlink stock price feed addresses on RH (or fallback source).

## Phases
1. Indexer + `/quote` (implied USD, depth, deviation, market-open).
2. `/prepare-swap` + `/gas`.
3. Corporate-action calendar + public agent with approval queue.
4. x402 Cloud deploy + skills-repo PR + README.

Target: first public post ready before the gas subsidy ends (late Sept 2026).