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
const stockFeeds = feeds.filter((f) => f.kind === 'stock');
const refFeeds = feeds.filter((f) => f.kind === 'reference');
console.log(`chainlink feeds: ${stockFeeds.length} equity`);
// Said either way. Its absence is why stock/WETH pools report
// no_eth_usd_reference_configured, and an operator should not have to read
// deviation.ts to find that out.
console.log(
  refFeeds.length
    ? `reference feeds: ${refFeeds.map((f) => `${f.symbol} (${f.name})`).join(', ')} ` +
        '— stock/WETH pools are now measurable'
    : 'reference feeds: none published for this chain — stock/WETH pools stay unmeasurable',
);

const cov = computeCoverage();
console.log(`\ncoverage: ${cov.covered.length}/${cov.total} (${(cov.coverageRatio * 100).toFixed(1)}%)`);
console.log(`uncovered: ${cov.uncovered.length} tokens have no Chainlink feed`);

const pending = tokens.filter((t) => t.pendingMultiplier);
const adjusted = tokens.filter((t) => Number(t.currentMultiplier) !== 1);
console.log(`multiplier != 1: ${adjusted.length} (${adjusted.map((t) => t.symbol).join(', ')})`);
console.log(`pending corporate actions: ${pending.length}`);
