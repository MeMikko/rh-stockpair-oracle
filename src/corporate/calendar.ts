import { getDb } from '../db/index.js';

const CA_URL = 'https://api.robinhood.com/rhj/corporate-actions';

export interface CorporateAction {
  id: string;
  tokenSymbol: string;
  tokenAddress: string | null;
  type: string;          // CASH_DIVIDEND, SPLIT, ...
  status: string;        // IN_PROGRESS | COMPLETED
  processDate: string;   // YYYY-MM-DD
  detail: Record<string, unknown>;
}

interface RawAction {
  id: string;
  type: string;
  status: string;
  processDate?: { year: number; month: number; day: number };
  tokenSymbol: string;
  deployments?: { contractAddress: string; chainId: number }[];
  details?: Record<string, unknown>;
}

const iso = (p?: { year: number; month: number; day: number }): string | null =>
  p ? `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}` : null;

const strip = (s: string, prefix: string) => s.startsWith(prefix) ? s.slice(prefix.length) : s;

/**
 * Robinhood's published calendar is the source of truth for corporate actions.
 * We deliberately do not reconstruct this from ERC-8056 events: the events only
 * appear when the multiplier actually changes, which is far too late to warn
 * anyone, and scanning 194 tokens for rare events is not viable on the public
 * RPC. The on-chain `newUIMultiplier`/`effectiveAt` pair is used to confirm an
 * action once it is staged, not to discover it.
 */
export async function fetchCorporateActions(): Promise<CorporateAction[]> {
  const res = await fetch(CA_URL, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`corporate-actions fetch failed: ${res.status}`);
  const body = (await res.json()) as { corpActions: RawAction[] };

  return (body.corpActions ?? []).flatMap((a) => {
    const date = iso(a.processDate);
    if (!date) return [];
    const dep = a.deployments?.find((d) => d.chainId === 4663);
    return [{
      id: a.id,
      tokenSymbol: a.tokenSymbol,
      tokenAddress: dep ? dep.contractAddress.toLowerCase() : null,
      type: strip(a.type, 'CORPORATE_ACTION_TYPE_'),
      status: strip(a.status, 'CORPORATE_ACTION_STATUS_'),
      processDate: date,
      detail: (a.details && (Object.values(a.details)[0] as Record<string, unknown>)) ?? {},
    }];
  });
}

export function saveCorporateActions(actions: CorporateAction[]): void {
  const db = getDb();
  const stmt = db.prepare(
    `INSERT INTO corporate_actions
       (id, token_symbol, token_address, type, status, process_date, detail_json, synced_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET status=excluded.status, process_date=excluded.process_date,
                                   detail_json=excluded.detail_json, synced_at=excluded.synced_at`,
  );
  const now = Date.now();
  db.exec('BEGIN');
  for (const a of actions) {
    stmt.run(a.id, a.tokenSymbol, a.tokenAddress, a.type, a.status, a.processDate,
             JSON.stringify(a.detail), now);
  }
  db.exec('COMMIT');
}

export interface ActionWithImpact extends CorporateAction {
  /** Indexed pools priced against this stock, i.e. what the action reprices. */
  affectedPools: number;
  daysAway: number;
}

const todayIso = (now = new Date()) => now.toISOString().slice(0, 10);

/** Actions dated today or later, soonest first, with pool impact attached. */
export function upcomingActions(withinDays = 30, now = new Date()): ActionWithImpact[] {
  const db = getDb();
  const today = todayIso(now);
  const rows = db.prepare(
    'SELECT * FROM corporate_actions WHERE process_date >= ? ORDER BY process_date ASC',
  ).all(today) as Record<string, unknown>[];

  const countPools = db.prepare(
    "SELECT COUNT(*) AS n FROM pools WHERE quote_kind = 'stock' AND stock_symbol = ?",
  );

  return rows.flatMap((r) => {
    const processDate = String(r.process_date);
    const daysAway = Math.round(
      (Date.parse(processDate + 'T00:00:00Z') - Date.parse(today + 'T00:00:00Z')) / 86_400_000,
    );
    if (daysAway > withinDays) return [];
    const { n } = countPools.get(String(r.token_symbol)) as { n: number };
    return [{
      id: String(r.id),
      tokenSymbol: String(r.token_symbol),
      tokenAddress: r.token_address ? String(r.token_address) : null,
      type: String(r.type),
      status: String(r.status),
      processDate,
      detail: JSON.parse(String(r.detail_json)) as Record<string, unknown>,
      affectedPools: Number(n),
      daysAway,
    }];
  });
}
