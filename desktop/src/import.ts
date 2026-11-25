import fs from 'node:fs';
import path from 'node:path';
import { parseEnv } from 'node:util';
import { utilityProcess } from 'electron';
import { DATA_DIR, DATABASE_FILE, ENV_FILE, SERVER_DIR } from './paths.js';

export interface ImportSource {
  dataDir: string;
  database: string;
}

/** Accepts a Streamora folder or the data folder inside it. Knows the database's old name. */
export function findImportSource(dir: string): ImportSource | null {
  for (const dataDir of [dir, path.join(dir, 'data')]) {
    for (const name of ['streamora.db', 'localstream.db']) {
      const database = path.join(dataDir, name);
      if (fs.existsSync(database)) return { dataDir, database };
    }
  }
  return null;
}

/** Copies the source database to `<DATABASE_FILE>.import`. The source may be in use. */
export async function copyDatabase(source: ImportSource): Promise<string> {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const staged = `${DATABASE_FILE}.import`;
  fs.rmSync(staged, { force: true });

  const child = utilityProcess.fork(path.join(SERVER_DIR, 'copy-database.mjs'), [source.database, staged], {
    serviceName: 'Streamora Import',
    cwd: SERVER_DIR,
    stdio: 'pipe',
  });
  let output = '';
  child.stderr?.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
  const code = await new Promise<number>((resolve) => child.once('exit', resolve));
  if (code !== 0) {
    fs.rmSync(staged, { force: true });
    throw new Error(output.match(/^\w*Error: .+$/m)?.[0] ?? `Copying the database failed (code ${code}).`);
  }
  return staged;
}

/**
 * Puts the copied database in place. The server must be stopped. The previous
 * database is kept next to it. Returns the path it was moved to, if there was one.
 */
export function activateDatabase(staged: string, source: ImportSource): string | null {
  let kept: string | null = null;
  if (fs.existsSync(DATABASE_FILE)) {
    kept = path.join(DATA_DIR, `streamora-before-import-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
    for (const suffix of ['-wal', '-shm', '']) {
      if (fs.existsSync(DATABASE_FILE + suffix)) fs.renameSync(DATABASE_FILE + suffix, kept + suffix);
    }
  }
  fs.renameSync(staged, DATABASE_FILE);

  const pluginData = path.join(source.dataDir, 'plugins');
  if (fs.existsSync(pluginData)) fs.cpSync(pluginData, path.join(DATA_DIR, 'plugins'), { recursive: true });
  importTmdbKey(path.join(path.dirname(source.dataDir), '.env'));
  return kept;
}

/** A TMDB key set in `.env` is not part of the database. */
function importTmdbKey(envFile: string): void {
  try {
    const key = parseEnv(fs.readFileSync(envFile, 'utf8')).TMDB_API_KEY;
    if (!key) return;
    const current = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, 'utf8') : '';
    if (parseEnv(current).TMDB_API_KEY) return;
    const separator = current === '' || current.endsWith('\n') ? '' : '\n';
    fs.writeFileSync(ENV_FILE, `${current}${separator}TMDB_API_KEY=${key}\n`);
  } catch {
    // No readable .env: the key can be entered in Admin > Plugins.
  }
}
