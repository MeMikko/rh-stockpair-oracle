import { decodeAbiParameters, decodeErrorResult, parseAbi, toFunctionSelector, type Hex } from 'viem';

/**
 * The v4 Quoter wraps any revert coming out of the pool or its hook in
 * UnexpectedRevertBytes(bytes), so the useful reason is one layer down. On RH
 * that layer matters more than usual: most stock-paired pools sit behind a
 * launchpad hook, and "the hook rejected this swap" is a completely different
 * answer from "the pool is too thin", both for /quote and for the calldata
 * helper in Phase 2.
 */
const UNEXPECTED_REVERT_BYTES = toFunctionSelector('function UnexpectedRevertBytes(bytes)');

const KNOWN_ERRORS = parseAbi([
  'error NotEnoughLiquidity(bytes32 poolId)',
  'error PoolNotInitialized()',
  'error SwapAmountCannotBeZero()',
  'error PriceLimitAlreadyExceeded(uint160 current, uint160 limit)',
  'error PriceLimitOutOfBounds(uint160 limit)',
  'error ManagerLocked()',
  'error CurrencyNotSettled()',
  'error InvalidHookResponse()',
  'error HookAddressNotValid(address hook)',
  'error NotSelf()',
  'error UnexpectedCallSuccess()',
  // Solidity builtins, declared explicitly so the decoded name is typed.
  'error Error(string message)',
  'error Panic(uint256 code)',
]);

export interface DecodedQuoterError {
  reason: string;
  /** Set when the failure came from the pool's hook rather than the pool. */
  wrapped: boolean;
  raw: string | null;
}

function tryDecode(data: Hex): string | null {
  try {
    const d = decodeErrorResult({ abi: KNOWN_ERRORS, data });
    // Solidity require-strings decode as the builtin Error(string); quote the
    // message so it is not mistaken for a custom error name.
    if (d.errorName === 'Error' && d.args?.length === 1) return `Error("${String(d.args[0])}")`;
    const args = d.args && d.args.length > 0 ? `(${d.args.map(String).join(', ')})` : '';
    return `${d.errorName}${args}`;
  } catch {
    // Solidity Error(string)
    try {
      if (data.startsWith('0x08c379a0')) {
        const [msg] = decodeAbiParameters([{ type: 'string' }], `0x${data.slice(10)}` as Hex);
        return `Error("${msg}")`;
      }
    } catch { /* fall through */ }
    return null;
  }
}

/** Extract the most specific reason available from a quoter revert. */
export function decodeQuoterError(data: Hex | undefined): DecodedQuoterError {
  if (!data || data === '0x') return { reason: 'no_revert_data', wrapped: false, raw: null };

  if (data.toLowerCase().startsWith(UNEXPECTED_REVERT_BYTES.toLowerCase())) {
    try {
      const [inner] = decodeAbiParameters([{ type: 'bytes' }], `0x${data.slice(10)}` as Hex);
      const decoded = tryDecode(inner as Hex);
      return {
        reason: decoded ?? `hook_or_pool_reverted (selector ${(inner as string).slice(0, 10)})`,
        wrapped: true,
        raw: inner as string,
      };
    } catch {
      return { reason: 'unexpected_revert_bytes_undecodable', wrapped: true, raw: data };
    }
  }

  return { reason: tryDecode(data) ?? `unknown_selector ${data.slice(0, 10)}`, wrapped: false, raw: data };
}

/**
 * Pull raw revert data out of a viem error. viem nests differently depending on
 * whether it could decode the error against the ABI, so walk the cause chain
 * and take the first hex payload found.
 */
export function extractRevertData(err: unknown): Hex | undefined {
  let cur: unknown = err;
  for (let i = 0; i < 6 && cur; i++) {
    const c = cur as { raw?: unknown; data?: unknown; cause?: unknown };
    const raw = c.raw ?? (typeof c.data === 'string' ? c.data : undefined);
    if (typeof raw === 'string' && raw.startsWith('0x') && raw.length >= 10) return raw as Hex;
    cur = c.cause;
  }
  return undefined;
}
