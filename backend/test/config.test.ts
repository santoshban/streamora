import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { tempDir } from './helpers/harness.js';

describe('default database path', () => {
  let dataDir: string;
  const databasePath = () => loadConfig({ NODE_ENV: 'test', DATA_DIR: dataDir }).databasePath;

  afterEach(() => fs.rmSync(dataDir, { recursive: true, force: true }));

  it('is streamora.db on a fresh install', () => {
    dataDir = tempDir();
    expect(databasePath()).toBe(path.join(dataDir, 'streamora.db'));
  });

  it('keeps using a localstream.db from before the rename', () => {
    dataDir = tempDir();
    fs.writeFileSync(path.join(dataDir, 'localstream.db'), '');
    expect(databasePath()).toBe(path.join(dataDir, 'localstream.db'));
  });

  it('prefers streamora.db once it exists', () => {
    dataDir = tempDir();
    fs.writeFileSync(path.join(dataDir, 'localstream.db'), '');
    fs.writeFileSync(path.join(dataDir, 'streamora.db'), '');
    expect(databasePath()).toBe(path.join(dataDir, 'streamora.db'));
  });

  it('DATABASE_PATH always wins', () => {
    dataDir = tempDir();
    fs.writeFileSync(path.join(dataDir, 'localstream.db'), '');
    const custom = path.join(dataDir, 'custom.db');
    expect(loadConfig({ NODE_ENV: 'test', DATA_DIR: dataDir, DATABASE_PATH: custom }).databasePath).toBe(custom);
  });
});
