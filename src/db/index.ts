import type { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { env } from '../../config/chain.js';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * node:sqlite is loaded through createRequire rather than a static import so
 * that bundlers and the test runner, which do not all know the builtin yet,
 * can still load modules that merely touch this file. It also keeps the
 * connection lazy: nothing opens a database just by importing a registry.
 */
const require = createRequire(import.meta.url);

let db: DatabaseSync | undefined;

/**
 * SQLite for v1. Every call site goes through the helpers below rather than
 * touching `db` directly, so swapping in Postgres later is a single-file job.
 */
export function getDb(): DatabaseSync {
  if (db) return db;
  const { DatabaseSync: DB } = require('node:sqlite') as typeof import('node:sqlite');
  mkdirSync(dirname(resolve(env.dbPath)), { recursive: true });
  db = new DB(resolve(env.dbPath));
  db.exec('PRAGMA journal_mode = WAL');
  // WAL allows many readers alongside one writer, but two writers still
  // collide -- and SQLite's default busy timeout is zero, so the loser fails
  // immediately with SQLITE_BUSY rather than waiting its turn. In deployment
  // that is not rare: the tip follower writes continuously while the daily
  // signal scan and the six-hourly sync also write. Wait instead of failing.
  db.exec('PRAGMA busy_timeout = 15000');
  db.exec(readFileSync(resolve(here, 'schema.sql'), 'utf8'));
  migrate(db);
  return db;
}

/**
 * Additive migrations for databases created by an earlier schema.
 *
 * schema.sql is all CREATE TABLE IF NOT EXISTS, which silently does nothing
 * when a table already exists -- so a new column never reaches an existing
 * database and every read of it fails at runtime rather than at startup.
 */
function migrate(db: DatabaseSync): void {
  const columns = (table: string): Set<string> =>
    new Set(
      (db.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{ name: string }>)
        .map((c) => c.name),
    );

  if (!columns('posts').has('reply_to')) {
    db.exec('ALTER TABLE posts ADD COLUMN reply_to TEXT');
  }

  // Rows written before x402 credit existed were all subscription payments,
  // which is exactly what the column default says, so the backfill is the
  // default and no UPDATE is needed.
  if (!columns('payments').has('purpose')) {
    db.exec("ALTER TABLE payments ADD COLUMN purpose TEXT NOT NULL DEFAULT 'pro'");
  }

  // Every feed stored before reference feeds existed was a Robinhood equity
  // feed, which is what the default says, so the backfill is the default.
  if (!columns('feeds').has('kind')) {
    db.exec("ALTER TABLE feeds ADD COLUMN kind TEXT NOT NULL DEFAULT 'stock'");
  }
}

export function getCursor(stream: string): number | null {
  const row = getDb()
    .prepare('SELECT last_block FROM cursor WHERE stream = ?')
    .get(stream) as { last_block: number } | undefined;
  return row ? Number(row.last_block) : null;
}

export function setCursor(stream: string, block: number): void {
  getDb()
    .prepare(
      `INSERT INTO cursor (stream, last_block, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(stream) DO UPDATE SET last_block = excluded.last_block,
                                         updated_at = excluded.updated_at`,
    )
    .run(stream, block, Date.now());
}
