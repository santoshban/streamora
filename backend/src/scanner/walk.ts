import type { Dirent } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { IGNORE_MARKERS, isExtraFile, isSkippedDir, isVideoFile } from '../media/extensions.js';

export interface WalkedFile {
  path: string;
  size: number;
  mtimeMs: number;
}

export interface WalkResult {
  files: WalkedFile[];
  /** Every folder visited → its mtime (used to spot new/removed sidecar subtitles). */
  dirs: Map<string, number>;
  /** Roots that could not be read (missing drive, unmounted share, permissions). */
  unreadableRoots: string[];
  /** Roots that exist but are empty — suspicious when the library already has files there. */
  emptyRoots: string[];
  errors: string[];
}

const MAX_DEPTH = 32;
const MAX_ERRORS = 50;

/** Case-insensitive on Windows and macOS, where the file system usually is. */
export const pathKey = (p: string) => (process.platform === 'win32' || process.platform === 'darwin' ? p.toLowerCase() : p);

class Walker {
  readonly result: WalkResult = { files: [], dirs: new Map(), unreadableRoots: [], emptyRoots: [], errors: [] };
  private readonly visited = new Set<string>();
  private steps = 0;

  constructor(private readonly signal?: AbortSignal) {}

  private error(message: string): void {
    if (this.result.errors.length < MAX_ERRORS) this.result.errors.push(message);
  }

  async walkDir(dir: string, depth: number): Promise<void> {
    this.signal?.throwIfAborted();
    if (depth > MAX_DEPTH) return;
    // Symlink loops: never enter the same real folder twice.
    const real = await fs.realpath(dir).catch(() => dir);
    if (this.visited.has(pathKey(real))) return;
    this.visited.add(pathKey(real));

    let entries: Dirent[];
    let mtimeMs = 0;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
      mtimeMs = (await fs.stat(dir)).mtimeMs;
    } catch (err) {
      this.error(`${dir}: ${(err as Error).message}`);
      return;
    }
    if (entries.some((e) => IGNORE_MARKERS.includes(e.name.toLowerCase()))) return;
    this.result.dirs.set(dir, mtimeMs);

    for (const entry of entries) {
      // Yield to the event loop now and then on huge folders.
      if (++this.steps % 500 === 0) await new Promise((r) => setImmediate(r));
      const full = path.join(dir, entry.name);
      let isDir = entry.isDirectory();
      let isFile = entry.isFile();
      if (entry.isSymbolicLink()) {
        const st = await fs.stat(full).catch(() => null);
        isDir = !!st?.isDirectory();
        isFile = !!st?.isFile();
      }
      if (isDir) {
        if (!isSkippedDir(entry.name)) await this.walkDir(full, depth + 1);
      } else if (isFile) {
        await this.addFile(full);
      }
    }
  }

  async addFile(file: string): Promise<void> {
    if (!isVideoFile(file) || isExtraFile(path.basename(file))) return;
    try {
      const st = await fs.stat(file);
      if (st.isFile()) this.result.files.push({ path: file, size: st.size, mtimeMs: Math.floor(st.mtimeMs) });
    } catch (err) {
      this.error(`${file}: ${(err as Error).message}`);
    }
  }
}

/** Recursively lists video files under every library root. */
export async function walkRoots(roots: string[], signal?: AbortSignal): Promise<WalkResult> {
  const walker = new Walker(signal);
  for (const root of roots) {
    try {
      const st = await fs.stat(root);
      if (!st.isDirectory()) throw new Error('not a directory');
      if ((await fs.readdir(root)).length === 0) walker.result.emptyRoots.push(root);
    } catch {
      walker.result.unreadableRoots.push(root);
      continue;
    }
    await walker.walkDir(root, 0);
  }
  return walker.result;
}

/**
 * Walks only `targets` (files or folders that changed). Paths that no longer
 * exist are returned in `gone`.
 */
export async function walkTargets(targets: string[], signal?: AbortSignal): Promise<WalkResult & { gone: string[] }> {
  const walker = new Walker(signal);
  const gone: string[] = [];
  for (const target of targets) {
    const st = await fs.stat(target).catch(() => null);
    if (!st) gone.push(target);
    else if (st.isDirectory()) await walker.walkDir(target, 0);
    else if (st.isFile()) await walker.addFile(target);
  }
  return { ...walker.result, gone };
}
