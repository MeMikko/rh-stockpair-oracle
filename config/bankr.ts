/**
 * The two Bankr credentials, kept deliberately apart.
 *
 * A Bankr API key carries independent capability flags — `llmGatewayEnabled`,
 * `walletApiEnabled`, `agentApiEnabled`, `tokenLaunchApiEnabled` — and one key
 * can hold all of them. That is the hazard this file exists to prevent: the
 * public server phrases answers through the LLM gateway, attaching its key to
 * a request whose body contains text a stranger wrote. If that key could also
 * sign, the blast radius of anything going wrong in that process is funds
 * rather than model credits.
 *
 * So there are two:
 *
 *  - `llmKey` — gateway only. Lives on the public box. Generate it at
 *    bankr.bot/api-keys with LLM Gateway enabled and wallet, agent and
 *    token-launch access OFF. `readOnly` does not restrict the gateway, so
 *    leave it on.
 *  - `adminKey` — wallet, agent and token launch. Lives ONLY in the admin
 *    process, which binds to loopback and is not published by Caddy.
 *
 * `assertLlmOnlyProcess()` enforces the split at boot rather than trusting a
 * deployment to keep them apart by habit.
 */

const env = (name: string): string => process.env[name]?.trim() ?? '';

export const bankr = {
  /** OpenAI/Anthropic-format gateway. Phrasing only, never the data path. */
  llmBaseUrl: env('BANKR_LLM_BASE_URL') || 'https://llm.bankr.bot',
  /**
   * BANKR_LLM_KEY is Bankr's own name for the gateway-only key; the older
   * BANKR_LLM_API_KEY is still read so an existing .env keeps working.
   */
  llmKey: env('BANKR_LLM_KEY') || env('BANKR_LLM_API_KEY'),
  llmModel: env('BANKR_LLM_MODEL') || 'claude-sonnet-5',

  /** Wallet, agent and token-launch API. Admin process only. */
  apiBaseUrl: env('BANKR_API_BASE_URL') || 'https://api.bankr.bot',
  adminKey: env('BANKR_API_KEY'),
} as const;

export function llmConfigured(): boolean {
  return bankr.llmKey.length > 0;
}

export function adminKeyConfigured(): boolean {
  return bankr.adminKey.length > 0;
}

/**
 * Refuse to run a public-facing process that holds the wallet-scoped key.
 *
 * Called from the public server's boot path. Failing to start is the right
 * outcome: a server that quietly runs with a key that can move funds is worse
 * than one that does not run at all, and the operator finds out immediately
 * rather than after an incident.
 */
export function assertLlmOnlyProcess(): void {
  // Read live rather than from the frozen snapshot above. The guard has to be
  // true of the process as it actually is at boot, not as it was when this
  // module happened to be first imported.
  const adminKey = env('BANKR_API_KEY');

  if (adminKey) {
    throw new Error(
      'BANKR_API_KEY is set in the public server process. That key can sign, ' +
        'transfer and launch tokens, and this process attaches its Bankr ' +
        'credential to requests containing caller-supplied text. Move it to ' +
        'the admin unit (npm run admin) and leave only BANKR_LLM_KEY here.',
    );
  }
}
