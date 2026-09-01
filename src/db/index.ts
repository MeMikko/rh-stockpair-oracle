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
  db.exec(readFileSync(resolve(here, 'schema.sql'), 'utf8'));
  return db;
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
