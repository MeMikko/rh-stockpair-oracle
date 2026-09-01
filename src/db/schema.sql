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
