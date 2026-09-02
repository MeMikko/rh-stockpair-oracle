import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'ment-')), 'test.db');

const { questionFromCast } = await import('../src/agent/mentions.js');

/**
 * A mention arrives as a whole post, and classifying all of it reads the
 * author's own prose as the query. The case that forced this: an announcement
 * saying "building an oracle" and linking oracle.sb4s.xyz was answered with
 * feed-coverage statistics, because the coverage rule matches `oracle` and our
 * own domain contains it — so it would have misfired on every cast sharing
 * the link.
 */
describe('questionFromCast', () => {
  it('takes what follows the handle', () => {
    const cast =
      'Spent the weekend building an oracle for Robinhood Chain.\n\n' +
      'It reads the pools where one side is a tokenized stock.\n\n' +
      'oracle.sb4s.xyz\n\n@vates introduce yourself';
    expect(questionFromCast(cast)).toBe('introduce yourself');
  });

  it('strips the link even when the question comes first', () => {
    const q = questionFromCast('@vates how many pools quote NVDA? see oracle.sb4s.xyz');
    expect(q).not.toMatch(/sb4s/);
    expect(q).toMatch(/how many pools quote NVDA/);
  });

  it('falls back to the whole cast when the handle is last', () => {
    expect(questionFromCast('what is TSLA price @vates')).toBe('what is TSLA price');
  });

  it('never leaves a URL in the question', () => {
    // Our own domain contains a keyword the classifier matches on.
    expect(questionFromCast('check oracle.sb4s.xyz @vates')).not.toMatch(/oracle\./);
    expect(questionFromCast('@vates look at https://example.com/x')).not.toMatch(/example/);
  });

  it('handles a bare mention with nothing after it', () => {
    expect(questionFromCast('@vates').length).toBe(0);
  });
});
