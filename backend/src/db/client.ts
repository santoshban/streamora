import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { MIGRATIONS_DIR } from '../lib/paths.js';
import * as schema from './schema.js';

export type DB = BetterSQLite3Database<typeof schema>;

export interface DatabaseHandle {
  db: DB;
  sqlite: Database.Database;
  close(): void;
}

/**
 * Opens (or creates) the SQLite database, applies pragmas tuned for a
 * single-process media server and runs pending migrations.
 * Pass `:memory:` for tests.
 */
export function openDatabase(file: string, options: { migrate?: boolean } = {}): DatabaseHandle {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });

  const sqlite = new Database(file);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('synchronous = NORMAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');

  const db = drizzle(sqlite, { schema });
  if (options.migrate !== false) migrate(db, { migrationsFolder: MIGRATIONS_DIR });

  return {
    db,
    sqlite,
    close: () => {
      if (sqlite.open) sqlite.close();
    },
  };
}
