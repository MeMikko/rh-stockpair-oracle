import { loadFeeds } from './feeds.js';
import { loadStockTokens } from './stockTokens.js';

/**
 * Oracle coverage across the stock-token universe.
 *
 * This is a first-class export, not a diagnostic: as of 2026-09-01 only 35 of
 * 194 canonical stock tokens have a Chainlink feed, so for ~82% of them a
 * "deviation vs Chainlink" number cannot be produced at all. /quote has to say
 * so explicitly rather than omit the field, and it is a publishable fact in its
 * own right.
 */
export interface Coverage {
  total: number;
  covered: string[];
  uncovered: string[];
  coverageRatio: number;
}

export function computeCoverage(): Coverage {
  const feedSymbols = new Set(loadFeeds().map((f) => f.symbol));
  const symbols = loadStockTokens().map((t) => t.symbol).sort();
  const covered = symbols.filter((s) => feedSymbols.has(s));
  const uncovered = symbols.filter((s) => !feedSymbols.has(s));
  return {
    total: symbols.length,
    covered,
    uncovered,
    coverageRatio: symbols.length === 0 ? 0 : covered.length / symbols.length,
  };
}
