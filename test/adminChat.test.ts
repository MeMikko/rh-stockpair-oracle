import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * What the panel's own agent can reach, and what it must not.
 *
 * The interesting tests here are negative. This chat runs with the
 * wallet-scoped Bankr key in the process, so the boundary between "reads the
 * service" and "acts on the service" is the whole safety story, and it is
 * enforced by which tools exist rather than by asking the model nicely.
 */
process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'chat-')), 'test.db');

const { TOOLS, runTool } = await import('../src/admin/chat.js');

const names = TOOLS.map((t) => t.name);

/**
 * The exact set, not a pattern.
 *
 * A substring rule was tried first and rejected `largest_trades` for
 * containing "trade". Worse than the false positive is what a loose rule
 * invites: a genuinely dangerous tool slipping through because nobody thought
 * of its name. Adding a tool now fails this test until someone writes it down
 * here, which is the point.
 */
const EXPECTED_TOOLS = [
  'service_overview', 'coverage', 'drift_history', 'volume_split',
  'largest_trades', 'corporate_actions', 'signals_and_queue',
  'bankr_wallet', 'bankr_launches', 'project_doc',
  // Writes a row for a human to approve. It does not call Bankr; see
  // src/admin/actions.ts, and the import check below, which is what actually
  // holds the line.
  'propose_action', 'pending_actions',
];

describe('the tools Vates has', () => {
  it('has exactly the tools it is meant to have', () => {
    expect([...names].sort()).toEqual([...EXPECTED_TOOLS].sort());
  });

  /**
   * The real guarantee is not the tool list but what the module can call at
   * all. deployToken, claimFees and Bankr's own agentPrompt act with the
   * wallet-scoped key that this process holds; if they are never imported,
   * no prompt can reach them.
   */
  it('never imports a Bankr function that acts', () => {
    const src = readFileSync(resolve('src/admin/chat.ts'), 'utf8');
    const imported = /import\s*\{([^}]+)\}\s*from\s*'\.\.\/bankr\/client\.js'/.exec(src);
    expect(imported, 'the bankr client import should be a named list').not.toBeNull();
    const namesImported = (imported?.[1] ?? '').split(',').map((x) => x.trim()).filter(Boolean);
    expect(namesImported.sort()).toEqual(['launches', 'portfolio', 'walletMe']);

    // Comments stripped first: the module names these functions in prose,
    // explaining why it does not have them. Naming a hazard is not reaching
    // for it, and a test that cannot tell the difference would push the
    // explanation out of the file.
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/^\s*\/\/.*$/gm, ' ');
    for (const acting of ['deployToken', 'claimFees', 'agentPrompt', 'probeSigning']) {
      expect(code, `${acting} must not be called from the panel chat`).not.toContain(acting);
    }

    // propose_action exists, so the chat can start an action — but only by
    // writing a row. It must reach actions.ts for proposing and listing, and
    // never for deciding: approveAction is the function that actually calls
    // Bankr, and it belongs to the route a human clicks.
    const fromActions = /import\s*\{([^}]+)\}\s*from\s*'\.\/actions\.js'/.exec(src);
    const actionImports = (fromActions?.[1] ?? '').split(',').map((x) => x.trim()).filter(Boolean);
    expect(actionImports.sort()).toEqual(['ACTIONS', 'listActions', 'proposeAction']);
    expect(code, 'the chat must not be able to approve its own proposal')
      .not.toContain('approveAction');
  });

  it('names every tool it dispatches, and dispatches every tool it names', async () => {
    for (const name of names) {
      const out = await runTool(name, {}).catch((e) => ({ threw: String(e) }));
      // A tool may report a missing argument or a failed upstream. What it may
      // not do is fall through to the unknown-tool branch.
      expect(JSON.stringify(out)).not.toContain('no tool named');
    }
  }, 30_000);

  it('refuses a tool it does not have', async () => {
    expect(await runTool('rm_rf', {})).toEqual({ error: 'no tool named rm_rf' });
  });
});

describe('project_doc', () => {
  /**
   * The panel is on the internet, so a tool that took a path would be a
   * file-read primitive reachable from a chat box. It takes a name.
   */
  it('reads only the documents on the list', async () => {
    for (const attempt of ['.env', '../.env', '/etc/passwd', 'docs/../.env', '']) {
      const out = (await runTool('project_doc', { name: attempt })) as { error?: string };
      expect(out.error, `should have refused ${JSON.stringify(attempt)}`).toContain('unknown document');
    }
  });

  it('names the documents it does have when it refuses', async () => {
    const out = (await runTool('project_doc', { name: 'nope' })) as { error: string };
    expect(out.error).toContain('readme');
    expect(out.error).toContain('claude');
  });

  it('reads one that is on the list', async () => {
    const out = (await runTool('project_doc', { name: 'readme' })) as
      { file?: string; content?: string; error?: string };
    expect(out.error).toBeUndefined();
    expect(out.file).toBe('README.md');
    expect((out.content ?? '').length).toBeGreaterThan(0);
  });
});

describe('drift_history', () => {
  it('asks for a symbol rather than guessing one', async () => {
    expect(await runTool('drift_history', {})).toEqual({ error: 'symbol is required' });
  });

  /**
   * An empty series is an answer, not an error. Saying "nothing sampled yet"
   * is what stops the model reading a trend into no readings.
   */
  it('says nothing is recorded rather than returning an empty shape', async () => {
    const out = (await runTool('drift_history', { symbol: 'NVDA' })) as
      { samples: number; note?: string };
    expect(out.samples).toBe(0);
    expect(out.note).toContain('nothing sampled');
  });
});
