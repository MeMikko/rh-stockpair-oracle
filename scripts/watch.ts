import { watch } from '../src/indexer/watch.js';
await watch({ intervalMs: 5_000, confirmations: 5 });
