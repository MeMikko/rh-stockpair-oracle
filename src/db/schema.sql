-- v1 storage. Deliberately narrow: everything here is reconstructible from
-- chain + the two public registries, so the DB is a cache, not a source of truth.

CREATE TABLE IF NOT EXISTS stock_tokens (
  address            TEXT PRIMARY KEY,   -- lowercase
  symbol             TEXT NOT NULL,
  name               TEXT NOT NULL,
  decimals           INTEGER NOT NULL,
  isin               TEXT,
  current_multiplier TEXT NOT NULL,      -- decimal string, from /rhj/assets
  pending_multiplier TEXT,
  status             TEXT NOT NULL,
  synced_at          INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS feeds (
  symbol          TEXT PRIMARY KEY,
  proxy_address   TEXT NOT NULL,
  secondary_proxy TEXT,
  decimals        INTEGER NOT NULL,
  heartbeat       INTEGER NOT NULL,
  threshold       REAL    NOT NULL,
  market_hours    TEXT,                  -- e.g. us_equities_24/5
  name            TEXT NOT NULL,
  synced_at       INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS pools (
  pool_id       TEXT PRIMARY KEY,        -- v4 PoolId (bytes32 hex, lowercase)
  currency0     TEXT NOT NULL,
  currency1     TEXT NOT NULL,
  fee           INTEGER NOT NULL,        -- 8388608 == dynamic
  tick_spacing  INTEGER NOT NULL,
  hooks         TEXT NOT NULL,
  init_block    INTEGER NOT NULL,
  init_tx       TEXT NOT NULL,
  init_sqrt_px  TEXT NOT NULL,
  init_tick     INTEGER NOT NULL,
  -- denormalised classification, filled by indexer/classify.ts
  stock_side    INTEGER,                 -- 0 | 1 | NULL when not stock-paired
  stock_symbol  TEXT,
  paired_token  TEXT,
  quote_kind    TEXT NOT NULL            -- stock | weth | usdg | other
);

CREATE INDEX IF NOT EXISTS pools_stock  ON pools(stock_symbol) WHERE stock_symbol IS NOT NULL;
CREATE INDEX IF NOT EXISTS pools_paired ON pools(paired_token);
CREATE INDEX IF NOT EXISTS pools_kind   ON pools(quote_kind);

-- Resumable backfill cursor. One row per logical stream.
CREATE TABLE IF NOT EXISTS cursor (
  stream     TEXT PRIMARY KEY,
  last_block INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Persistent token metadata cache. Decimals are immutable, so every RPC call
-- to fetch one twice is waste -- and on the public endpoint, waste is the
-- difference between answering a request and being rate limited.
CREATE TABLE IF NOT EXISTS token_meta (
  address  TEXT PRIMARY KEY,
  symbol   TEXT,
  decimals INTEGER NOT NULL,
  source   TEXT NOT NULL,   -- registry | rpc | builtin
  synced_at INTEGER NOT NULL
);

-- Rolling log of gas observations. The L1 data price on this chain briefly
-- reads non-zero and then returns to zero, so a single sample cannot tell you
-- whether the launch subsidy has ended. Keeping a short history turns that
-- from a coin flip into evidence.
CREATE TABLE IF NOT EXISTS gas_samples (
  block                 INTEGER PRIMARY KEY,
  observed_at           INTEGER NOT NULL,
  per_l1_calldata_unit  TEXT NOT NULL,
  l1_base_fee_estimate  TEXT NOT NULL,
  base_fee_per_gas      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS gas_samples_time ON gas_samples(observed_at);

-- Corporate actions on the pricing assets. Sourced from Robinhood's published
-- calendar; on this chain a dividend or split is applied through the ERC-8056
-- uiMultiplier, so each one reprices every pool paired to that stock.
CREATE TABLE IF NOT EXISTS corporate_actions (
  id            TEXT PRIMARY KEY,
  token_symbol  TEXT NOT NULL,
  token_address TEXT,
  type          TEXT NOT NULL,      -- CASH_DIVIDEND, SPLIT, ...
  status        TEXT NOT NULL,      -- IN_PROGRESS | COMPLETED | ...
  process_date  TEXT NOT NULL,      -- YYYY-MM-DD
  detail_json   TEXT NOT NULL,
  synced_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ca_date   ON corporate_actions(process_date);
CREATE INDEX IF NOT EXISTS ca_symbol ON corporate_actions(token_symbol);

-- Signals are deterministic observations worth telling someone about. The
-- LLM never invents these; it only phrases one that already exists.
CREATE TABLE IF NOT EXISTS signals (
  id           TEXT PRIMARY KEY,    -- stable hash: same observation = same id
  kind         TEXT NOT NULL,
  severity     TEXT NOT NULL,       -- info | notable | high
  summary      TEXT NOT NULL,
  facts_json   TEXT NOT NULL,       -- every number a post may cite
  reproduce    TEXT NOT NULL,       -- endpoint call that reproduces the claim
  detected_at  INTEGER NOT NULL
);

-- Approval queue. Nothing reaches a public timeline without passing through
-- here and being explicitly approved by a person.
CREATE TABLE IF NOT EXISTS posts (
  id           TEXT PRIMARY KEY,
  signal_id    TEXT NOT NULL REFERENCES signals(id),
  status       TEXT NOT NULL,       -- draft | approved | rejected | posted | failed
  channels     TEXT NOT NULL,       -- csv: farcaster,x
  draft_text   TEXT NOT NULL,
  drafted_by   TEXT NOT NULL,       -- llm:<model> | template
  created_at   INTEGER NOT NULL,
  decided_at   INTEGER,
  decided_by   TEXT,
  posted_at    INTEGER,
  post_refs    TEXT,
  error        TEXT,
  -- Set when this post is a reply rather than a broadcast: the platform id of
  -- the message being answered. A reply and a post are the same object here on
  -- purpose -- both are public claims and both need the same approval.
  reply_to     TEXT
);
CREATE INDEX IF NOT EXISTS posts_status ON posts(status);

-- Uniswap v3 pools. Kept in their own table rather than merged into `pools`:
-- a v3 pool is an address with its own Swap events, a v4 pool is a PoolId
-- inside one singleton, and flattening the two would hide exactly the
-- distinction a coverage claim depends on.
CREATE TABLE IF NOT EXISTS pools_v3 (
  address       TEXT PRIMARY KEY,        -- pool contract, lowercase
  token0        TEXT NOT NULL,
  token1        TEXT NOT NULL,
  fee           INTEGER NOT NULL,
  tick_spacing  INTEGER NOT NULL,
  init_block    INTEGER NOT NULL,
  init_tx       TEXT NOT NULL,
  stock_side    INTEGER,
  stock_symbol  TEXT,
  paired_token  TEXT,
  quote_kind    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS pools_v3_stock ON pools_v3(stock_symbol) WHERE stock_symbol IS NOT NULL;
CREATE INDEX IF NOT EXISTS pools_v3_kind  ON pools_v3(quote_kind);

-- Rolling swap-volume accumulator. Individual swaps are not stored: the chain
-- produces far more of them than a v1 cache should hold, and no endpoint
-- answers a per-swap question. One row per pool per measured window, replaced
-- on each run, so a volume claim always carries the window it was measured
-- over rather than being an undated total.
CREATE TABLE IF NOT EXISTS pool_volume (
  pool_key     TEXT NOT NULL,            -- v4 PoolId or v3 pool address
  protocol     TEXT NOT NULL,            -- v4 | v3
  from_block   INTEGER NOT NULL,
  to_block     INTEGER NOT NULL,
  from_ts      INTEGER NOT NULL,
  to_ts        INTEGER NOT NULL,
  swaps        INTEGER NOT NULL,
  abs_amount0  TEXT NOT NULL,            -- summed |amount0|, raw units
  abs_amount1  TEXT NOT NULL,
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (pool_key, protocol)
);
CREATE INDEX IF NOT EXISTS pool_volume_swaps ON pool_volume(swaps DESC);

-- Explorer-sourced token facts. Kept apart from token_meta on purpose:
-- token_meta holds what the chain says (decimals, symbol) and feeds the
-- pricing path, while this holds what an index says (holder counts, the
-- explorer's own USD rate) and feeds nothing that /quote returns.
CREATE TABLE IF NOT EXISTS token_explorer (
  address       TEXT PRIMARY KEY,
  symbol        TEXT,
  name          TEXT,
  decimals      INTEGER,
  holders       INTEGER,
  total_supply  TEXT,
  exchange_rate REAL,
  synced_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS token_explorer_holders ON token_explorer(holders DESC);

-- Per-day, per-route, per-caller call counts.
--
-- Exists before billing does, because the price of a call should be set from
-- its measured cost and measured demand rather than guessed. Callers are an
-- API-key hash or a salted hash of the remote address -- never the address
-- itself; this is a usage counter, not a visitor log.
CREATE TABLE IF NOT EXISTS usage (
  day     TEXT NOT NULL,          -- YYYY-MM-DD
  route   TEXT NOT NULL,
  caller  TEXT NOT NULL,
  calls   INTEGER NOT NULL,
  last_at INTEGER NOT NULL,
  PRIMARY KEY (day, route, caller)
);
CREATE INDEX IF NOT EXISTS usage_day   ON usage(day);
CREATE INDEX IF NOT EXISTS usage_route ON usage(route);

-- Who has paid for what.
--
-- Deliberately the narrowest possible memory: it records entitlement, not
-- conversation. The agent still cannot remember what anyone told it, which is
-- what keeps it unpersuadable -- an agent that remembers claims can be taught
-- to believe one. This table only answers "is this subject entitled, and until
-- when".
--
-- A subject is a Farcaster FID or a wallet address. Which one matters for
-- trust, not just identity: an FID arriving from Neynar's API is asserted by
-- Neynar, while an address or FID arriving in an HTTP request is asserted by
-- whoever made the request. See src/entitlements/index.ts.
CREATE TABLE IF NOT EXISTS entitlements (
  subject_type TEXT NOT NULL,      -- fid | address
  subject      TEXT NOT NULL,      -- fid: digits; address: lowercase 0x…
  tier         TEXT NOT NULL,      -- pro
  granted_at   INTEGER NOT NULL,
  expires_at   INTEGER,            -- NULL = does not expire
  source       TEXT NOT NULL,      -- manual | payment:<ref>
  note         TEXT,
  PRIMARY KEY (subject_type, subject)
);
CREATE INDEX IF NOT EXISTS entitlements_tier ON entitlements(tier, expires_at);

-- Autonomous replies actually sent, for rate limiting and for an audit trail.
--
-- Separate from `posts` on purpose: a post is something a person approved, and
-- an autonomous reply is something nobody approved. Keeping them in one table
-- would blur the only distinction that matters here. One row per cast replied
-- to, so a restart cannot double-answer.
CREATE TABLE IF NOT EXISTS auto_replies (
  cast_hash  TEXT PRIMARY KEY,
  fid        TEXT NOT NULL,
  replied_at INTEGER NOT NULL,
  intent     TEXT,
  ref        TEXT              -- platform id of the reply we sent
);
CREATE INDEX IF NOT EXISTS auto_replies_fid_time ON auto_replies(fid, replied_at);
CREATE INDEX IF NOT EXISTS auto_replies_time ON auto_replies(replied_at);
