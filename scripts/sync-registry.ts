import { fetchStockTokens, saveStockTokens } from '../src/registry/stockTokens.js';
import { seedTokenMeta } from '../src/registry/tokenMeta.js';
import { fetchFeeds, saveFeeds } from '../src/registry/feeds.js';
import { computeCoverage } from '../src/registry/coverage.js';

const tokens = await fetchStockTokens();
saveStockTokens(tokens);
seedTokenMeta(tokens);
console.log(`stock tokens: ${tokens.length} (token_meta seeded)`);

const feeds = await fetchFeeds();
saveFeeds(feeds);
console.log(`chainlink feeds: ${feeds.length}`);

const cov = computeCoverage();
console.log(`\ncoverage: ${cov.covered.length}/${cov.total} (${(cov.coverageRatio * 100).toFixed(1)}%)`);
console.log(`uncovered: ${cov.uncovered.length} tokens have no Chainlink feed`);

const pending = tokens.filter((t) => t.pendingMultiplier);
const adjusted = tokens.filter((t) => Number(t.currentMultiplier) !== 1);
console.log(`multiplier != 1: ${adjusted.length} (${adjusted.map((t) => t.symbol).join(', ')})`);
console.log(`pending corporate actions: ${pending.length}`);
