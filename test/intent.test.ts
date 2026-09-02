import { describe, it, expect } from 'vitest';
import { classify, findSymbol } from '../src/answer/intent.js';

/**
 * The classifier is the whole reason an answer can be deterministic, so its
 * collisions matter more than its successes. Both of the cases below were
 * real misclassifications found by asking the agent ordinary questions.
 */
const known = new Set(['NVDA', 'TSLA', 'ON', 'PR', 'GME', 'SPY']);

describe('findSymbol', () => {
  it('matches a known ticker as a whole word', () => {
    expect(findSymbol('how many pools quote NVDA?', known)).toBe('NVDA');
  });

  it('ignores lowercase words that collide with tickers', () => {
    // "on" and "pr" are real tickers on this chain. Matching case-insensitively
    // would turn most English sentences into a ticker lookup.
    expect(findSymbol('what is going on with gas', known)).toBeNull();
    expect(findSymbol('does ON have a feed', known)).toBe('ON');
  });

  it('returns null when no known ticker appears', () => {
    expect(findSymbol('what is the weather in Helsinki', known)).toBeNull();
  });
});

describe('classify', () => {
  it('reads "quote" as a verb, not a quote request', () => {
    // "how many pools quote NVDA" is a pool count. A quote request names a pool.
    expect(classify('how many pools quote NVDA?').kind).toBe('pools');
  });

  it('does not mistake a volume split for a stock split', () => {
    expect(classify('what is the v3/v4 volume split?').kind).toBe('protocol_split');
    expect(classify('what is the protocol split').kind).toBe('protocol_split');
  });

  it('still reads a bare split as a corporate action', () => {
    expect(classify('is there an NVDA split coming?').kind).toBe('corporate_action');
    expect(classify('any reverse split soon').kind).toBe('corporate_action');
  });

  it('treats a bare pool id as a quote request', () => {
    const i = classify('tell me about 0x' + 'a'.repeat(64));
    expect(i.kind).toBe('quote');
    expect(i.poolRef).toMatch(/^0x/);
  });

  it('gives up rather than guessing', () => {
    expect(classify('what is the weather in Helsinki?').kind).toBe('unknown');
    expect(classify('gm').kind).toBe('unknown');
  });

  it('routes unambiguous corporate-action words even alongside other cues', () => {
    expect(classify('how many pools does the NVDA dividend reprice?').kind).toBe(
      'corporate_action',
    );
  });
});
