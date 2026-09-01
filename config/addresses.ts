import type { Address } from 'viem';

/**
 * Robinhood Chain (4663) contract addresses.
 *
 * Every address here was confirmed to carry bytecode on mainnet on
 * 2026-09-01 at block ~52,007,893. `npm run verify:addresses` re-runs that
 * check; CI should fail if any entry goes dark, because these came from
 * documentation and documentation drifts.
 */

export const CHAIN_ID = 4663;

/** Uniswap v4 -- where essentially all new RH pool creation happens. */
export const V4 = {
  poolManager: '0x8366a39cc670b4001a1121b8f6a443a643e40951',
  positionManager: '0x58daec3116aae6d93017baaea7749052e8a04fa7',
  stateView: '0xf3334192d15450cdd385c8b70e03f9a6bd9e673b',
  quoter: '0x8dc178efb8111bb0973dd9d722ebeff267c98f94',
} as const satisfies Record<string, Address>;

/** Uniswap v3. Live, but a small minority of stock-paired liquidity. */
export const V3 = {
  factory: '0x1f7d7550b1b028f7571e69a784071f0205fd2efa',
  quoterV2: '0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7',
  swapRouter02: '0xcaf681a66d020601342297493863e78c959e5cb2',
  nftPositionManager: '0x73991a25c818bf1f1128deaab1492d45638de0d3',
} as const satisfies Record<string, Address>;

/** Shared routing infrastructure. */
export const ROUTER = {
  universalRouter: '0x8876789976decbfcbbbe364623c63652db8c0904',
  permit2: '0x000000000022D473030F116dDEE9F6B43aC78BA3',
} as const satisfies Record<string, Address>;

/** Core tokens. Note USDG is 6 decimals while every stock token is 18. */
export const TOKENS = {
  weth: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73',
  usdg: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168',
} as const satisfies Record<string, Address>;

export const MISC = {
  multicall3: '0x2cAC2D899eCC914d704FeaAE33ac1bF36277DaD1',
  entryPointV07: '0x0000000071727de22e5e9d8baf0edac6f37da032',
} as const satisfies Record<string, Address>;

/**
 * Known launchpad hooks, for attribution only.
 *
 * The indexer is deliberately hook-agnostic -- it keys off PoolManager
 * Initialize events, so a new launchpad is picked up with no code change.
 * This map only supplies a human label. Unknown hooks are normal.
 *
 * Doppler was confirmed by walking a real Bankr launch: the hook self-reports
 * airlock() = 0xeb7C..0862 and poolManager() = the v4 PoolManager above.
 */
export const HOOK_LABELS: Record<string, string> = {
  '0x4e3468951d49f2eea976ed0d6e75ffcb44a9a544': 'doppler (bankr)',
  '0xeb7c034704ef8dcd2d32324c1545f62fb4ad0862': 'doppler airlock',
  '0x0000fffbe8efe702c8703ae3477ff5de3d319c0': 'uniswap liquidity launcher',
  '0x23f8209572b4a1c2ad88a42749e830791fb027f1': 'uniswap instant launch (creator fees)',
  '0xad44d55e7f8337c3ce113fbb591486e85be104b2': 'uniswap instant launch',
  '0x05d552391067389ee44fec3924157ed33f976000': 'uniswap LBP strategy',
};

/** Uniswap v4 dynamic-fee sentinel (0x800000). Pools using it must be */
/** quoted live -- the stored fee is meaningless for them. */
export const DYNAMIC_FEE_FLAG = 8_388_608;

export function labelHook(hook: string): string | null {
  return HOOK_LABELS[hook.toLowerCase()] ?? null;
}
