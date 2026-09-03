import { bankr, adminKeyConfigured } from '../../config/bankr.js';

/**
 * The wallet-scoped half of Bankr, reachable only from the admin process.
 *
 * Every call here can cost money or move it, which is why nothing in this file
 * is imported by `src/api` — the public server has no path to it and no key
 * that would satisfy it.
 *
 * Reads are separated from writes deliberately: `walletMe`, `portfolio`,
 * `launches` and `tokenFees` cannot change anything, so the panel can show a
 * dashboard without the operator ever authorising a write.
 */

const TIMEOUT_MS = 30_000;

export class BankrError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body?: unknown,
  ) {
    super(message);
  }
}

async function call<T>(
  path: string,
  init: { method?: 'GET' | 'POST'; body?: unknown; auth?: boolean } = {},
): Promise<T> {
  const auth = init.auth !== false;
  if (auth && !adminKeyConfigured()) {
    throw new BankrError(0, 'BANKR_API_KEY is not set in this process');
  }

  const headers: Record<string, string> = { accept: 'application/json' };
  if (auth) headers['x-api-key'] = bankr.adminKey;
  if (init.body !== undefined) headers['content-type'] = 'application/json';

  let res: Response;
  try {
    res = await fetch(`${bankr.apiBaseUrl}${path}`, {
      method: init.method ?? 'GET',
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new BankrError(0, `could not reach ${bankr.apiBaseUrl}: ${(err as Error).message}`);
  }

  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }

  if (!res.ok) {
    // Bankr returns {error, message}; surface the message because its 403s
    // name the exact capability flag that is missing, which is the whole
    // diagnostic when a key is scoped wrongly.
    const b = parsed as { error?: string; message?: string } | null;
    const detail = b?.message ?? b?.error ?? (typeof parsed === 'string' ? parsed.slice(0, 200) : '');
    throw new BankrError(res.status, `${path} → ${res.status}${detail ? `: ${detail}` : ''}`, parsed);
  }
  return parsed as T;
}

/* ---------------------------------------------------------------- reads -- */

export interface WalletMe {
  wallets?: Array<{ chain: string; address: string }>;
  socialAccounts?: Array<{ platform: string; username: string }>;
  bankrClub?: { active?: boolean; subscriptionType?: string; renewOrCancelOn?: number };
}

export const walletMe = (): Promise<WalletMe> => call<WalletMe>('/wallet/me');

export interface Portfolio {
  evmAddress?: string;
  solAddress?: string;
  balances?: Record<
    string,
    {
      nativeBalance?: string;
      nativeUsd?: string;
      total?: string;
      tokenBalances?: Array<{
        token?: {
          // A string, and left as one: these are exact decimal amounts, and
          // parsing a high-decimal token as a float rounds it upward.
          balance?: string;
          balanceUSD?: number;
          baseToken?: { symbol?: string; name?: string; address?: string; price?: number };
        };
      }>;
    }
  >;
}

/** Balances across the chains we care about. Robinhood first — it is ours. */
export const portfolio = (chains = 'robinhood,base'): Promise<Portfolio> =>
  call<Portfolio>(`/wallet/portfolio?chains=${encodeURIComponent(chains)}`);

export interface Launch {
  status?: string;
  tokenName?: string;
  tokenSymbol?: string;
  chain?: string;
  tokenAddress?: string;
  feeRecipient?: { walletAddress?: string };
  timestamp?: number;
}

/** The 50 most recent Bankr launches. Unauthenticated, so no key is spent. */
export const launches = (): Promise<{ launches?: Launch[] }> =>
  call<{ launches?: Launch[] }>('/token-launches', { auth: false });

export interface TokenFees {
  totals?: { claimableWeth?: string; claimedWeth?: string; claimCount?: number };
  lifetimeEarnedWeth?: string;
  tokens?: Array<{ tokenAddress?: string; symbol?: string; poolId?: string; initializer?: string }>;
}

/** Claimable and claimed fees for one token. Also unauthenticated. */
export const tokenFees = (tokenAddress: string, days = 30): Promise<TokenFees> =>
  call<TokenFees>(`/token-launches/${tokenAddress}/fees?days=${days}`, { auth: false });

/* --------------------------------------------------------------- writes -- */

export interface DeployRequest {
  tokenName: string;
  tokenSymbol: string;
  /** Where the creator's fee share goes. Defaults to the agent's own wallet. */
  feeRecipient?: { type: 'wallet' | 'x' | 'farcaster' | 'ens'; value: string };
  /** Omitted means Robinhood Chain (4663) — the chain this service indexes. */
  chain?: 'base';
  simulateOnly?: boolean;
}

export interface DeployResult {
  success?: boolean;
  tokenAddress?: string;
  poolId?: string;
  txHash?: string;
  chain?: string;
  feeDistribution?: Record<string, { address?: string; bps?: number }>;
}

/**
 * Deploy a token.
 *
 * Irreversible when `simulateOnly` is false, and rate limited to three counted
 * attempts per rolling 24 hours per wallet — a failed real deploy is a spent
 * slot, which is why the admin route simulates first by default.
 */
export const deployToken = (req: DeployRequest): Promise<DeployResult> =>
  call<DeployResult>('/token-launches/deploy', { method: 'POST', body: req });

export interface ClaimResult {
  transactionHash?: string;
  status?: string;
  signer?: string;
  chainId?: number;
  description?: string;
}

/** Collect the creator fee share. Requires walletApiEnabled on the key. */
export const claimFees = (tokenAddress: string): Promise<ClaimResult> =>
  call<ClaimResult>(`/token-launches/${tokenAddress}/fees/claim`, { method: 'POST', body: {} });

/* ---------------------------------------------------------- agent API -- */

export interface AgentJob {
  jobId?: string;
  threadId?: string;
  status?: 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled';
  prompt?: string;
  response?: string;
  error?: string;
  processingTime?: number;
}

/**
 * Hand a sentence to Bankr's own agent.
 *
 * Asynchronous by design at their end: this returns a jobId and the answer
 * arrives by polling. Worth being blunt about what it is — with a read-write
 * key the agent *executes*, so "sell all my BNKR" is a trade and not a
 * question. Requires agentApiEnabled on the key, which is off by default, and
 * a Bankr Club subscription or Max Mode credits.
 */
export const agentPrompt = (prompt: string, threadId?: string): Promise<AgentJob> =>
  call<AgentJob>('/agent/prompt', {
    method: 'POST',
    body: threadId ? { prompt, threadId } : { prompt },
  });

export const agentJob = (jobId: string): Promise<AgentJob> =>
  call<AgentJob>(`/agent/job/${encodeURIComponent(jobId)}`);

/* ------------------------------------------------------------ capability -- */

/**
 * What a key can actually do, established by asking rather than by trusting
 * the dashboard toggles to be what you remember setting.
 *
 * `personal_sign` is the probe because it is the cheapest true write: it moves
 * nothing, is exempt from the recipient allowlist, and a read-only or
 * gateway-only key is refused with 403. A 200 means the key can sign.
 */
export async function probeSigning(key: string): Promise<{ canSign: boolean; status: number; detail: string }> {
  let res: Response;
  try {
    res = await fetch(`${bankr.apiBaseUrl}/wallet/sign`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, accept: 'application/json' },
      body: JSON.stringify({ signatureType: 'personal_sign', message: 'scope probe' }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    return { canSign: false, status: 0, detail: `unreachable: ${(err as Error).message}` };
  }
  const body = (await res.text()).slice(0, 200);
  return { canSign: res.ok, status: res.status, detail: body };
}
