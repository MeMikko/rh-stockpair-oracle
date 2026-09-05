import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Proposals, and the gap between proposing and running.
 *
 * The property under test is not "the agent behaves". It is that a human's
 * click executes the parameters the card displayed, and that nothing between
 * the proposal and the click can change them — because the data the agent
 * reads contains strings written by strangers, and the whole design rests on
 * a person reading an address before anything moves.
 */
process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'actions-')), 'test.db');

const calls: Array<{ fn: string; arg: unknown }> = [];
vi.mock('../src/bankr/client.js', () => ({
  deployToken: async (req: unknown) => {
    calls.push({ fn: 'deployToken', arg: req });
    return { success: true, tokenAddress: '0x' + 'a'.repeat(40) };
  },
  claimFees: async (addr: unknown) => {
    calls.push({ fn: 'claimFees', arg: addr });
    return { status: 'ok' };
  },
}));

const { getDb } = await import('../src/db/index.js');
const { proposeAction, approveAction, rejectAction, listActions, loadAction } =
  await import('../src/admin/actions.js');

const AGENT = '0x' + '1'.repeat(40);
const OTHER = '0x' + '2'.repeat(40);

beforeEach(() => {
  getDb().exec('DELETE FROM pending_actions');
  calls.length = 0;
});

describe('proposing', () => {
  it('refuses an action it does not have', () => {
    expect(() => proposeAction('drain_wallet', {}, 'because I said so')).toThrow(/no such action/);
  });

  it('names the actions it does have when it refuses', () => {
    expect(() => proposeAction('nope', {}, 'a reason long enough')).toThrow(/launch_token/);
  });

  /** An approver cannot judge an action with no stated reason. */
  it('insists on a rationale', () => {
    expect(() => proposeAction('claim_fees', { tokenAddress: AGENT }, 'x')).toThrow(/rationale/);
  });

  it('validates a fee recipient rather than passing it through', () => {
    expect(() =>
      proposeAction('launch_token',
        { tokenName: 'Vates', tokenSymbol: 'VATES', feeRecipient: 'not-an-address' },
        'so the launch earns fees the agent can later claim'),
    ).toThrow(/0x wallet address/);
  });

  /**
   * Bankr accepts x/farcaster/ens recipients too. They resolve to an address
   * the approver cannot read off the card, which defeats the card.
   */
  it('takes only a wallet address as the recipient', () => {
    expect(() =>
      proposeAction('launch_token',
        { tokenName: 'Vates', tokenSymbol: 'VATES', feeRecipient: '@someone' },
        'so the launch earns fees the agent can later claim'),
    ).toThrow(/0x wallet address/);
  });

  it('defaults the recipient to the agent wallet by omitting it', () => {
    const a = proposeAction('launch_token', { tokenName: 'Vates', tokenSymbol: 'VATES' },
      'so there is something to claim fees from');
    expect(a.params.feeRecipient).toBeUndefined();
    expect(a.status).toBe('pending');
  });

  it('rejects a malformed symbol', () => {
    expect(() =>
      proposeAction('launch_token', { tokenName: 'Vates', tokenSymbol: 'not a symbol!' },
        'a reason long enough to pass'),
    ).toThrow(/tokenSymbol/);
  });

  it('runs nothing at proposal time', () => {
    proposeAction('claim_fees', { tokenAddress: AGENT }, 'to collect what the pool has earned');
    expect(calls).toEqual([]);
  });
});

describe('deciding', () => {
  it('executes the stored parameters, not any passed in later', async () => {
    const a = proposeAction('claim_fees', { tokenAddress: AGENT },
      'to collect what the pool has earned so far');
    await approveAction(a.id, 'operator');
    expect(calls).toEqual([{ fn: 'claimFees', arg: AGENT.toLowerCase() }]);
  });

  it('passes a launch through in the shape Bankr expects', async () => {
    const a = proposeAction('launch_token',
      { tokenName: 'Vates', tokenSymbol: 'vates', feeRecipient: OTHER },
      'so the agent has a token whose fees it can later claim');
    await approveAction(a.id, 'operator');
    expect(calls).toEqual([{
      fn: 'deployToken',
      arg: {
        tokenName: 'Vates',
        tokenSymbol: 'VATES',
        feeRecipient: { type: 'wallet', value: OTHER.toLowerCase() },
      },
    }]);
  });

  /** A double-clicked approve button must not launch two tokens. */
  it('runs an action once, however many times it is approved', async () => {
    const a = proposeAction('launch_token', { tokenName: 'Vates', tokenSymbol: 'VATES' },
      'so there is something to claim fees from');
    const [first, second] = await Promise.allSettled([
      approveAction(a.id, 'operator'),
      approveAction(a.id, 'operator'),
    ]);
    const settled = [first, second];
    expect(settled.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(calls).toHaveLength(1);
  });

  it('will not run a rejected action', async () => {
    const a = proposeAction('claim_fees', { tokenAddress: AGENT }, 'to collect the earned fees');
    rejectAction(a.id, 'operator');
    await expect(approveAction(a.id, 'operator')).rejects.toThrow(/already rejected/);
    expect(calls).toEqual([]);
  });

  it('records who decided, and when', async () => {
    const a = proposeAction('claim_fees', { tokenAddress: AGENT }, 'to collect the earned fees');
    const done = await approveAction(a.id, 'owner.eth');
    expect(done.decidedBy).toBe('owner.eth');
    expect(done.decidedAt).toBeGreaterThan(0);
    expect(done.status).toBe('executed');
  });

  it('reports an unknown id rather than doing nothing quietly', async () => {
    await expect(approveAction('deadbeef', 'operator')).rejects.toThrow(/no action/);
  });

  it('lists what was proposed and what became of it', async () => {
    const a = proposeAction('claim_fees', { tokenAddress: AGENT }, 'to collect the earned fees');
    await approveAction(a.id, 'operator');
    const all = listActions();
    expect(all).toHaveLength(1);
    expect(all[0]?.status).toBe('executed');
    expect(loadAction(a.id)?.result).toEqual({ status: 'ok' });
  });
});
