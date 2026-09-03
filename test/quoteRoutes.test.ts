import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The parts of the quote surface that do not need a chain.
 *
 * Deliberately not a test of a quote: a real one reads pool state and
 * simulates a swap, and faking either would test the fake. What is testable
 * here is everything a caller hits *before* that — which identifiers are
 * recognised, what a miss says, and whether a v3 pool is now reachable at all
 * — and that is exactly where the v3 gap lived.
 */
process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'quote-routes-')), 'test.db');

const { getDb } = await import('../src/db/index.js');
const { registerQuote } = await import('../src/api/routes/quote.js');
const { registerData } = await import('../src/api/routes/data.js');
const { registerPrepareSwap } = await import('../src/api/routes/prepareSwap.js');

const NVDA = '0x1111111111111111111111111111111111111111';
const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const V4_ID = `0x${'ab'.repeat(32)}`;
const V3_ADDR = '0x2222222222222222222222222222222222222222';
const V3_QUIET = '0x3333333333333333333333333333333333333333';

const app = Fastify();

beforeAll(async () => {
  const db = getDb();
  db.prepare(
    `INSERT INTO stock_tokens (address, symbol, name, decimals, current_multiplier, status, synced_at)
     VALUES (?, 'NVDA', 'NVIDIA', 18, '1', 'active', ?)`,
  ).run(NVDA, Date.now());

  db.prepare(
    `INSERT INTO pools (pool_id, currency0, currency1, fee, tick_spacing, hooks, init_block,
                        init_tx, init_sqrt_px, init_tick, stock_side, stock_symbol,
                        paired_token, quote_kind)
     VALUES (?, ?, ?, 3000, 60, '0x0000000000000000000000000000000000000000', 100,
             '0xtx', '1', 0, 1, 'NVDA', ?, 'stock')`,
  ).run(V4_ID, USDG, NVDA, USDG);

  const v3 = db.prepare(
    `INSERT INTO pools_v3 (address, token0, token1, fee, tick_spacing, init_block, init_tx,
                           stock_side, stock_symbol, paired_token, quote_kind)
     VALUES (?, ?, ?, 10000, 200, ?, '0xtx', 1, 'NVDA', ?, 'stock')`,
  );
  v3.run(V3_ADDR, USDG, NVDA, 200, USDG);
  v3.run(V3_QUIET, USDG, NVDA, 300, USDG);

  // Only the busy v3 pool has a measurement; the quiet one has none, which is
  // not the same as a measured zero.
  db.prepare(
    `INSERT INTO pool_volume (pool_key, protocol, from_block, to_block, from_ts, to_ts, swaps,
                              abs_amount0, abs_amount1, updated_at)
     VALUES (?, 'v3', 1, 2, 1, 2, 4242, '0', '0', ?)`,
  ).run(V3_ADDR, Date.now());

  registerQuote(app);
  registerData(app);
  registerPrepareSwap(app);
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe('finding a pool to quote', () => {
  /**
   * A count is not actionable. Until /pools returned identifiers, the only way
   * to obtain one was to index the chain yourself.
   */
  it('lists both protocols with the identifiers /quote takes', async () => {
    const res = await app.inject({ method: 'GET', url: '/pools?symbol=NVDA' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ symbol: 'NVDA', v4Pools: 1, v3Pools: 2, totalPools: 3 });
    expect(body.pools).toHaveLength(3);
    expect(body.pools.map((p: { protocol: string }) => p.protocol).sort()).toEqual([
      'v3', 'v3', 'v4',
    ]);
    for (const p of body.pools) expect(p.quote).toBe(`GET /quote?pool=${p.pool}`);
  });

  it('puts the pool that actually trades first', async () => {
    const body = (await app.inject({ method: 'GET', url: '/pools?symbol=NVDA' })).json();
    expect(body.pools[0].pool).toBe(V3_ADDR);
    expect(body.pools[0].swaps24h).toBe(4242);
  });

  /** Never measured is null, not zero -- the distinction the README insists on. */
  it('reports an unmeasured pool as null rather than as zero volume', async () => {
    const body = (await app.inject({ method: 'GET', url: '/pools?symbol=NVDA' })).json();
    const quiet = body.pools.find((p: { pool: string }) => p.pool === V3_QUIET);
    expect(quiet.swaps24h).toBeNull();
  });

  it('still 404s a symbol that is not a stock token here', async () => {
    expect((await app.inject({ method: 'GET', url: '/pools?symbol=ZZZZ' })).statusCode).toBe(404);
  });
});

describe('/quote', () => {
  it('asks for an identifier and says where to get one', async () => {
    const res = await app.inject({ method: 'GET', url: '/quote' });
    expect(res.statusCode).toBe(400);
    expect(res.json().find).toMatch(/\/pools\?symbol=/);
  });

  /**
   * The v3 gap, as a test.
   *
   * A v3 address used to be answered `pool not indexed`. It is now looked up,
   * and the proof without a chain is the size check that sits between the
   * lookup and the first RPC: a recognised pool with a bad size answers 400,
   * an unrecognised one answers 404. Anything past that point needs the chain
   * and is not faked here.
   */
  it('recognises a v3 pool address instead of calling it unindexed', async () => {
    const res = await app.inject({ method: 'GET', url: `/quote?pool=${V3_ADDR}&size=lots` });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/positive number/);
  });

  it('recognises a v4 poolId the same way', async () => {
    const res = await app.inject({ method: 'GET', url: `/quote?pool=${V4_ID}&size=lots` });
    expect(res.statusCode).toBe(400);
  });

  it('is case-insensitive about a v3 address', async () => {
    const upper = `0x${V3_ADDR.slice(2).toUpperCase()}`;
    const res = await app.inject({ method: 'GET', url: `/quote?pool=${upper}&size=lots` });
    expect(res.statusCode).toBe(400);
  });

  it('explains a genuine miss rather than just refusing', async () => {
    const res = await app.inject({ method: 'GET', url: `/quote?pool=0x${'99'.repeat(20)}&size=lots` });
    expect(res.statusCode).toBe(404);
    expect(res.json().note).toMatch(/pools\?symbol/);
  });
});

describe('/prepare-swap on a v3 pool', () => {
  /**
   * 501 and not 404: the pool is indexed and quotable, and the honest answer
   * is that the calldata shape is different, not that the pool is unknown.
   */
  it('says the pool is v3 and points at the quote it can serve', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/prepare-swap',
      payload: { pool: V3_ADDR, amountIn: '1000000', zeroForOne: true },
    });
    expect(res.statusCode).toBe(501);
    expect(res.json()).toMatchObject({ protocol: 'v3', quotable: `GET /quote?pool=${V3_ADDR}` });
  });

  it('still 404s a pool nobody has indexed', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/prepare-swap',
      payload: { pool: `0x${'99'.repeat(20)}`, amountIn: '1000000', zeroForOne: true },
    });
    expect(res.statusCode).toBe(404);
  });
});
