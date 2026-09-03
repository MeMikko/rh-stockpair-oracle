import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * A deployment with no facilitator, which is what every deployment is until an
 * operator sets one.
 *
 * Its own file because the config module snapshots the environment on import,
 * and the property under test is precisely what that snapshot decides: a
 * scheme advertised with nothing behind it makes a client sign an
 * authorization that will never be read, and then loop on the retry.
 */
process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'x402-unset-')), 'test.db');
delete process.env.X402_FACILITATOR_URL;

const { payment402Body } = await import('../src/api/x402.js');
const DOMAIN = { name: 'USD Coin', version: '2', source: 'fallback' as const };

describe('no facilitator configured', () => {
  const body = payment402Body('/quote', DOMAIN);

  it('does not advertise the exact scheme', () => {
    expect(body.accepts.some((a) => a.scheme === 'exact')).toBe(false);
    expect(body.settlement.standardX402).toBe(false);
    expect(body.settlement.facilitator).toBeNull();
  });

  it('still names something that works', () => {
    expect(body.accepts[0]!.scheme).toBe('onchain-transfer-credit');
    expect(body.settlement.standardX402Note).toMatch(/no facilitator/i);
  });
});
