import type { Address, Hex } from 'viem';
import { getClient } from '../../config/chain.js';
import { ARB_GAS_INFO, NODE_INTERFACE, SUBSIDY_EXPECTED_END } from '../../config/gasConstants.js';
import { ARB_GAS_INFO_ABI, NODE_INTERFACE_ABI } from '../abi.js';
import { recordGasSample, subsidyEvidence, type SubsidyEvidence } from './gasHistory.js';

export interface GasSnapshot {
  blockNumber: string;
  baseFeePerGas: string;
  gasPrice: string;
  minimumGasPrice: string;
  /** baseFee attributable to congestion above the floor. */
  congestionWei: string;
  perArbGasTotal: string;
  /** Cost per byte of L1 calldata. Zero while the launch subsidy is active. */
  perL1CalldataUnit: string;
  l1BaseFeeEstimate: string;
  gasBacklog: string;
  subsidy: {
    /**
     * Measured, never assumed from a date -- but note this is evidence from a
     * window of samples, not a single read. The instantaneous value flaps.
     */
    l1DataFreeNow: boolean;
    evidence: SubsidyEvidence;
    expectedEnd: string;
    note: string;
  };
}

const minutes = (seconds: number) => Math.max(1, Math.round(seconds / 60));
const at = (unix: number) => new Date(unix * 1000).toISOString().replace('.000Z', 'Z');

/**
 * Say which of the two non-free states this is.
 *
 * The counts alone cannot tell them apart -- 26 non-zero samples out of 107 is
 * an ended subsidy if those 26 are the most recent ones and a flapping reading
 * if they are scattered -- so the note leads with the run in progress and keeps
 * the window counts as supporting detail.
 */
function subsidyNote(l1DataFreeNow: boolean, e: SubsidyEvidence): string {
  if (l1DataFreeNow) {
    return `L1 calldata charged at zero across all ${e.samples} retained sample(s): the launch subsidy is active. Costs below are L2-only and will rise when it ends.`;
  }
  if (e.currentNonZeroRun === 0) {
    return `L1 calldata is zero at this block and has been unbroken since ${e.zeroSince === null ? 'the start of the window' : at(e.zeroSince)}, but ${e.nonZeroSamples} of ${e.samples} retained samples were non-zero. The reading flaps; treat the subsidy as uncertain, not ended.`;
  }
  return `L1 calldata is being charged, unbroken across the last ${e.currentNonZeroRun} sample(s) spanning ${minutes(e.currentNonZeroRunSeconds)} minute(s) (${e.nonZeroSamples} of ${e.samples} retained samples non-zero). Charging comes in bursts that revert: as of 2026-09-03 the longest measured ran 25 minutes, over 12 bursts in 16 hours. Weigh the run against that before concluding the subsidy has ended.`;
}

export async function readGas(): Promise<GasSnapshot> {
  const c = getClient();
  const [prices, l1Base, minPrice, backlog, block, gasPrice] = await Promise.all([
    c.readContract({ address: ARB_GAS_INFO as Address, abi: ARB_GAS_INFO_ABI, functionName: 'getPricesInWei' }),
    c.readContract({ address: ARB_GAS_INFO as Address, abi: ARB_GAS_INFO_ABI, functionName: 'getL1BaseFeeEstimate' }),
    c.readContract({ address: ARB_GAS_INFO as Address, abi: ARB_GAS_INFO_ABI, functionName: 'getMinimumGasPrice' }),
    c.readContract({ address: ARB_GAS_INFO as Address, abi: ARB_GAS_INFO_ABI, functionName: 'getGasBacklog' }),
    c.getBlock(),
    c.getGasPrice(),
  ]);

  const [, perL1CalldataUnit, , perArbGasBase, perArbGasCongestion, perArbGasTotal] = prices;
  const freeAtThisBlock = perL1CalldataUnit === 0n && l1Base === 0n;

  recordGasSample(block.number ?? 0n, perL1CalldataUnit, l1Base, block.baseFeePerGas ?? 0n);
  const evidence = subsidyEvidence(freeAtThisBlock);
  const l1DataFreeNow = evidence.freeAcrossWindow;

  return {
    blockNumber: String(block.number),
    baseFeePerGas: String(block.baseFeePerGas ?? 0n),
    gasPrice: String(gasPrice),
    minimumGasPrice: String(minPrice),
    congestionWei: String(perArbGasCongestion),
    perArbGasTotal: String(perArbGasTotal),
    perL1CalldataUnit: String(perL1CalldataUnit),
    l1BaseFeeEstimate: String(l1Base),
    gasBacklog: String(backlog),
    subsidy: {
      l1DataFreeNow,
      evidence,
      expectedEnd: SUBSIDY_EXPECTED_END,
      note: subsidyNote(l1DataFreeNow, evidence),
    },
  };
}

export interface GasEstimate {
  gasEstimate: string;
  gasForL1: string;
  gasForL2: string;
  baseFee: string;
  l1BaseFeeEstimate: string;
  totalWei: string;
  totalEth: number;
}

/**
 * Split an estimate into its L2 and L1-data components via NodeInterface.
 * Plain eth_estimateGas folds the two together, which hides exactly the number
 * that matters once the subsidy lapses.
 */
export async function estimateComponents(to: Address, data: Hex, from?: Address): Promise<GasEstimate> {
  const c = getClient();
  let result: readonly [bigint, bigint, bigint, bigint];
  try {
    const sim = await c.simulateContract({
      address: NODE_INTERFACE as Address,
      abi: NODE_INTERFACE_ABI,
      functionName: 'gasEstimateComponents',
      args: [to, false, data],
      ...(from ? { account: from } : {}),
    });
    result = sim.result as readonly [bigint, bigint, bigint, bigint];
  } catch (err) {
    // Gas estimation executes the call, so it inherits every requirement the
    // real transaction has. Without a `from` that actually holds the tokens and
    // has approved them, a swap or transfer reverts here for reasons that have
    // nothing to do with gas. Say that, rather than "unknown reason".
    const base = (err as Error).message.split('\n')[0] ?? 'estimate failed';
    throw new Error(
      from
        ? `${base} -- the call reverts for ${from}; check balance, approvals and min-out`
        : `${base} -- no 'from' supplied, so the call executes as the zero address and reverts unless it is a plain transfer. Pass from/recipient to estimate a real swap.`,
    );
  }

  const [gasEstimate, gasForL1, baseFee, l1BaseFeeEstimate] = result;
  const totalWei = gasEstimate * baseFee;
  return {
    gasEstimate: String(gasEstimate),
    gasForL1: String(gasForL1),
    gasForL2: String(gasEstimate - gasForL1),
    baseFee: String(baseFee),
    l1BaseFeeEstimate: String(l1BaseFeeEstimate),
    totalWei: String(totalWei),
    totalEth: Number(totalWei) / 1e18,
  };
}
