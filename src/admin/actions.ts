import { randomUUID } from 'node:crypto';
import { getDb } from '../db/index.js';
import { claimFees, deployToken, type DeployRequest } from '../bankr/client.js';

/**
 * Bankr actions the agent proposes and a human executes.
 *
 * The agent has no tool that calls Bankr's acting endpoints. It has one that
 * writes a row here. The panel renders the row's parameters verbatim, and
 * approving it runs the call from the server, out of the model's reach.
 *
 * WHY THE ORDERING MATTERS, concretely rather than as a principle. Tool
 * results already carry text written by strangers: `/token-launches` returns
 * `tokenName` and `tokenSymbol` for the 50 most recent launches on Bankr,
 * written by whoever launched them, and the stock pools on this chain are
 * paired against tokens named "Greatest Meme Ever" and "Hugging Face". While
 * every tool reads, the worst such a string can do is mislead an answer. Give
 * the model a function that spends and the same string becomes an instruction
 * worth writing. A person reading the address before anything moves is what
 * keeps the first situation true after the second becomes possible.
 *
 * So this file's job is not to decide whether an action is wise. It is to make
 * sure the thing a human approved is the thing that runs: parameters are
 * validated on the way in, stored, shown, and read back from storage at
 * execution time. Nothing the model says between proposal and approval can
 * change them.
 */

export type ActionStatus = 'pending' | 'rejected' | 'executed' | 'failed';

export interface PendingAction {
  id: string;
  kind: string;
  params: Record<string, unknown>;
  rationale: string;
  status: ActionStatus;
  createdAt: number;
  decidedBy: string | null;
  decidedAt: number | null;
  result: unknown;
  error: string | null;
}

/**
 * One entry per action the agent may propose.
 *
 * `validate` runs at proposal time and again is not trusted afterwards:
 * `execute` reads the stored row. `summary` is what the approval card leads
 * with, so it has to name the thing that moves — an address, a recipient — and
 * not merely the verb.
 */
interface ActionSpec {
  /** Human-readable, for the approval card's heading. */
  summary(params: Record<string, unknown>): string;
  /** Returns a normalised parameter object, or throws with a usable reason. */
  validate(params: Record<string, unknown>): Record<string, unknown>;
  execute(params: Record<string, unknown>): Promise<unknown>;
}

const isAddress = (v: unknown): v is string =>
  typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v.trim());

export const ACTIONS: Record<string, ActionSpec> = {
  /**
   * Launch a token for the agent.
   *
   * There is nothing to claim until something has been launched, which is why
   * this is here rather than left out as the more obviously dangerous of the
   * two. The fee recipient is the parameter worth staring at on the card: it
   * decides where the creator's share goes, and it is exactly the field a
   * hostile string would try to set.
   */
  launch_token: {
    summary: (p) =>
      `Launch ${String(p.tokenSymbol)} ("${String(p.tokenName)}")` +
      (p.feeRecipient ? `, fees to ${String(p.feeRecipient)}` : ', fees to the agent wallet'),
    validate: (p) => {
      const name = String(p.tokenName ?? '').trim();
      const symbol = String(p.tokenSymbol ?? '').trim().toUpperCase();
      if (name.length < 1 || name.length > 60) throw new Error('tokenName must be 1-60 characters');
      if (!/^[A-Z0-9]{2,11}$/.test(symbol)) throw new Error('tokenSymbol must be 2-11 letters or digits');
      const out: Record<string, unknown> = { tokenName: name, tokenSymbol: symbol };
      // Only a wallet address, and only when asked for. The other recipient
      // types Bankr accepts (x, farcaster, ens) resolve elsewhere to something
      // the approver cannot read off the card, which defeats the point of the
      // card.
      if (p.feeRecipient !== undefined && p.feeRecipient !== null && String(p.feeRecipient).length > 0) {
        if (!isAddress(p.feeRecipient)) {
          throw new Error('feeRecipient must be a 0x wallet address, or omitted for the agent wallet');
        }
        out.feeRecipient = String(p.feeRecipient).toLowerCase();
      }
      return out;
    },
    execute: async (p) => {
      const req: DeployRequest = {
        tokenName: String(p.tokenName),
        tokenSymbol: String(p.tokenSymbol),
      };
      if (p.feeRecipient) req.feeRecipient = { type: 'wallet', value: String(p.feeRecipient) };
      return await deployToken(req);
    },
  },

  /**
   * Collect the creator fee share for a token already launched.
   *
   * Moves value only towards the agent's own wallet, which is why it is the
   * safer of the two — but the token address still decides which pool is
   * touched, so it is validated and shown rather than trusted.
   */
  claim_fees: {
    summary: (p) => `Claim creator fees for ${String(p.tokenAddress)}`,
    validate: (p) => {
      if (!isAddress(p.tokenAddress)) throw new Error('tokenAddress must be a 0x address');
      return { tokenAddress: String(p.tokenAddress).toLowerCase() };
    },
    execute: async (p) => await claimFees(String(p.tokenAddress)),
  },
};

function row2action(r: Record<string, unknown>): PendingAction {
  return {
    id: String(r.id),
    kind: String(r.kind),
    params: JSON.parse(String(r.params_json)) as Record<string, unknown>,
    rationale: String(r.rationale),
    status: String(r.status) as ActionStatus,
    createdAt: Number(r.created_at),
    decidedBy: r.decided_by ? String(r.decided_by) : null,
    decidedAt: r.decided_at ? Number(r.decided_at) : null,
    result: r.result_json ? JSON.parse(String(r.result_json)) : null,
    error: r.error ? String(r.error) : null,
  };
}

/** Record a proposal. Validates now so a malformed one never reaches a card. */
export function proposeAction(
  kind: string,
  params: Record<string, unknown>,
  rationale: string,
): PendingAction {
  const spec = ACTIONS[kind];
  if (!spec) {
    throw new Error(`no such action: ${kind}. Available: ${Object.keys(ACTIONS).join(', ')}`);
  }
  const reason = rationale.trim();
  // An action with no stated reason is one an approver cannot judge, and the
  // rationale is the part a person actually reads before clicking.
  if (reason.length < 10) throw new Error('rationale must say why, in at least a sentence');

  const clean = spec.validate(params);
  const id = randomUUID().slice(0, 8);
  getDb()
    .prepare(
      `INSERT INTO pending_actions (id, kind, params_json, rationale, status, created_at)
       VALUES (?, ?, ?, ?, 'pending', ?)`,
    )
    .run(id, kind, JSON.stringify(clean), reason, Date.now());
  return loadAction(id)!;
}

export function loadAction(id: string): PendingAction | null {
  const r = getDb().prepare('SELECT * FROM pending_actions WHERE id = ?').get(id) as
    Record<string, unknown> | undefined;
  return r ? row2action(r) : null;
}

export function listActions(status?: ActionStatus, limit = 25): PendingAction[] {
  const db = getDb();
  const rows = (status
    ? db.prepare('SELECT * FROM pending_actions WHERE status = ? ORDER BY created_at DESC LIMIT ?')
        .all(status, limit)
    : db.prepare('SELECT * FROM pending_actions ORDER BY created_at DESC LIMIT ?').all(limit)
  ) as Array<Record<string, unknown>>;
  return rows.map(row2action);
}

export function rejectAction(id: string, by: string): PendingAction {
  const action = loadAction(id);
  if (!action) throw new Error(`no action ${id}`);
  if (action.status !== 'pending') throw new Error(`action ${id} is already ${action.status}`);
  getDb()
    .prepare("UPDATE pending_actions SET status = 'rejected', decided_by = ?, decided_at = ? WHERE id = ?")
    .run(by, Date.now(), id);
  return loadAction(id)!;
}

/**
 * Run an approved action.
 *
 * Parameters come from the row, never from the caller. The approve button
 * sends an id and nothing else, so what executes is what was displayed —
 * there is no field for a caller, or anything upstream of one, to substitute.
 *
 * Claiming 'pending' in the same statement that reads it is what stops a
 * double-click from launching two tokens.
 */
export async function approveAction(id: string, by: string): Promise<PendingAction> {
  const db = getDb();
  const claimed = db
    .prepare(
      `UPDATE pending_actions SET status = 'executed', decided_by = ?, decided_at = ?
       WHERE id = ? AND status = 'pending'`,
    )
    .run(by, Date.now(), id);
  if (claimed.changes === 0) {
    const existing = loadAction(id);
    throw new Error(existing ? `action ${id} is already ${existing.status}` : `no action ${id}`);
  }

  const action = loadAction(id)!;
  const spec = ACTIONS[action.kind];
  if (!spec) {
    db.prepare("UPDATE pending_actions SET status = 'failed', error = ? WHERE id = ?")
      .run(`no such action: ${action.kind}`, id);
    return loadAction(id)!;
  }

  try {
    const result = await spec.execute(action.params);
    db.prepare('UPDATE pending_actions SET result_json = ? WHERE id = ?')
      .run(JSON.stringify(result), id);
  } catch (err) {
    // Left as 'failed' rather than returned to 'pending': a Bankr call that
    // errored may still have moved something, and offering a retry button on
    // an action whose effect is unknown is how a token gets launched twice.
    db.prepare("UPDATE pending_actions SET status = 'failed', error = ? WHERE id = ?")
      .run((err as Error).message.slice(0, 500), id);
  }
  return loadAction(id)!;
}
