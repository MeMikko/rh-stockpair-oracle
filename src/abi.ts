import { parseAbi, parseAbiItem } from 'viem';

/** PoolManager Initialize -- the single source of pool discovery. */
export const INITIALIZE_EVENT = parseAbiItem(
  'event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)',
);

/**
 * PoolManager Swap. Every v4 swap on the chain lands here regardless of hook,
 * which is what makes chain-wide volume readable from one address.
 * amount0/amount1 are signed from the *pool's* perspective.
 */
export const V4_SWAP_EVENT = parseAbiItem(
  'event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)',
);

/** UniswapV3Factory pool discovery. v3 pools are separate contracts. */
export const V3_POOL_CREATED_EVENT = parseAbiItem(
  'event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)',
);

/**
 * v3 Swap is emitted by each pool contract, not by the factory, so a chain-wide
 * v3 volume read filters by event topic across all addresses and resolves the
 * pool from the log address.
 */
export const V3_SWAP_EVENT = parseAbiItem(
  'event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)',
);

export const V3_POOL_ABI = parseAbi([
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
  'function liquidity() view returns (uint128)',
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function fee() view returns (uint24)',
]);

export const V3_FACTORY_ABI = parseAbi([
  'function getPool(address tokenA, address tokenB, uint24 fee) view returns (address)',
]);

export const STATE_VIEW_ABI = parseAbi([
  'function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)',
  'function getLiquidity(bytes32 poolId) view returns (uint128 liquidity)',
]);

/**
 * v4 Quoter. These are simulate-only (they revert to return data), so always
 * reach them through eth_call / simulateContract, never a transaction.
 */
export const V4_QUOTER_ABI = parseAbi([
  'struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }',
  'struct QuoteExactSingleParams { PoolKey poolKey; bool zeroForOne; uint128 exactAmount; bytes hookData; }',
  'function quoteExactInputSingle(QuoteExactSingleParams params) returns (uint256 amountOut, uint256 gasEstimate)',
]);

/**
 * v3 QuoterV2. Same discipline as the v4 quoter: it is nonpayable and returns
 * through a revert internally, so it is only ever reached through eth_call.
 *
 * The struct and return tuple are v3-periphery's, unchanged -- RH's v3 is a
 * stock deployment. `sqrtPriceLimitX96: 0` means "no limit", which is what a
 * quote wants: the point is to learn the impact, not to cap it.
 */
export const V3_QUOTER_V2_ABI = parseAbi([
  'struct QuoteExactInputSingleParams { address tokenIn; address tokenOut; uint256 amountIn; uint24 fee; uint160 sqrtPriceLimitX96; }',
  'function quoteExactInputSingle(QuoteExactInputSingleParams params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
]);

/**
 * The two shapes a Uniswap v3 router can have, and the read that tells them
 * apart.
 *
 * `SwapRouter` (v3-periphery) carries the deadline *inside* the params struct.
 * `SwapRouter02` (swap-router-contracts) dropped it, and enforces a deadline
 * through `multicall(uint256 deadline, bytes[] data)` instead. The two structs
 * differ by one field, so the selectors differ -- calldata for one is not
 * merely suboptimal on the other, it is unrecognised.
 *
 * `factoryV2()` exists only on SwapRouter02, which is what makes it a cheap,
 * read-only way to establish which is deployed rather than trusting a variable
 * name to be right.
 */
export const V3_SWAP_ROUTER_02_ABI = parseAbi([
  'struct ExactInputSingleParams { address tokenIn; address tokenOut; uint24 fee; address recipient; uint256 amountIn; uint256 amountOutMinimum; uint160 sqrtPriceLimitX96; }',
  'function exactInputSingle(ExactInputSingleParams params) payable returns (uint256 amountOut)',
  'function multicall(uint256 deadline, bytes[] data) payable returns (bytes[] results)',
  'function factoryV2() view returns (address)',
  'function WETH9() view returns (address)',
]);

export const V3_SWAP_ROUTER_01_ABI = parseAbi([
  'struct ExactInputSingleParams01 { address tokenIn; address tokenOut; uint24 fee; address recipient; uint256 deadline; uint256 amountIn; uint256 amountOutMinimum; uint160 sqrtPriceLimitX96; }',
  'function exactInputSingle(ExactInputSingleParams01 params) payable returns (uint256 amountOut)',
]);

export const ERC20_APPROVE_ABI = parseAbi([
  'function approve(address spender, uint256 amount) returns (bool)',
]);

export const ERC20_ABI = parseAbi([
  'function symbol() view returns (string)',
  'function name() view returns (string)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
]);

/**
 * ERC-8056 Scaled UI Amount, as implemented by Robinhood Stock Tokens.
 * Corporate actions land here rather than in a rebase, which is why the
 * corporate-action calendar is an on-chain read for us and not a vendor feed.
 */
export const STOCK_TOKEN_ABI = parseAbi([
  'function uiMultiplier() view returns (uint256)',
  'function newUIMultiplier() view returns (uint256)',
  'function effectiveAt() view returns (uint256)',
  'function oraclePaused() view returns (bool)',
  // Signatures per the ERC-8056 spec, not inferred: UIMultiplierUpdated carries
  // three unindexed uints, and an announced action can be withdrawn, which a
  // calendar has to reflect.
  'event UIMultiplierUpdated(uint256 oldMultiplier, uint256 newMultiplier, uint256 effectiveAtTimestamp)',
  'event UIMultiplierUpdateCancelled(uint256 cancelledMultiplier, uint256 cancelledEffectiveAt)',
]);

export const AGGREGATOR_V3_ABI = parseAbi([
  'function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
  'function decimals() view returns (uint8)',
  'function description() view returns (string)',
]);

/** Arbitrum Nitro gas precompiles. RH inherits these from the Orbit stack. */
export const ARB_GAS_INFO_ABI = parseAbi([
  'function getPricesInWei() view returns (uint256 perL2Tx, uint256 perL1CalldataUnit, uint256 perStorageAllocation, uint256 perArbGasBase, uint256 perArbGasCongestion, uint256 perArbGasTotal)',
  'function getL1BaseFeeEstimate() view returns (uint256)',
  'function getMinimumGasPrice() view returns (uint256)',
  'function getGasBacklog() view returns (uint64)',
]);

/**
 * NodeInterface is a virtual contract: it has no bytecode and is only
 * reachable through eth_call. It is the only way to split an Orbit gas
 * estimate into its L2 and L1-data components.
 */
export const NODE_INTERFACE_ABI = parseAbi([
  'function gasEstimateComponents(address to, bool contractCreation, bytes data) returns (uint64 gasEstimate, uint64 gasEstimateForL1, uint256 baseFee, uint256 l1BaseFeeEstimate)',
]);

/** UniversalRouter entrypoint. Selector 0x3593564c, confirmed against live RH txs. */
export const UNIVERSAL_ROUTER_ABI = parseAbi([
  'function execute(bytes commands, bytes[] inputs, uint256 deadline) payable',
]);
