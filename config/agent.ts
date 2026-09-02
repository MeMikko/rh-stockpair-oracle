/**
 * Who the agent is, as distinct from what the service does.
 *
 * The service is the RH stock-pair oracle; the account that speaks for it is
 * Vates. Keeping the name here rather than hardcoding it in a prompt means the
 * landing page, the skill and the model's own introduction cannot drift apart
 * -- and an agent that introduces itself by the wrong name is a small thing
 * that reads as carelessness everywhere else.
 */
export const agentIdentity = {
  name: process.env.AGENT_NAME?.trim() || 'Vates',
  farcasterHandle: process.env.AGENT_FARCASTER_HANDLE?.trim() || 'vates',
  get farcasterUrl(): string {
    return `https://farcaster.xyz/${this.farcasterHandle}`;
  },
  service: 'RH stock-pair oracle',
};
