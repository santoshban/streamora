import fs from 'node:fs/promises';
import path from 'node:path';
import type { FileEntry, PluginFileSystem, ReadTextOptions } from '@streamora/plugin-sdk';
import { isPathInside } from '../../lib/paths.js';

const DEFAULT_MAX_TEXT = 5 * 1024 * 1024;
const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;

/** Decodes text honouring BOMs, then strict UTF-8, falling back to Windows-1252. */
export function decodeText(buffer: Uint8Array, encoding: ReadTextOptions['encoding'] = 'auto'): string {
  if (encoding === 'utf8') return new TextDecoder('utf-8').decode(buffer).replace(/^﻿/, '');
  if (encoding === 'latin1') return new TextDecoder('windows-1252').decode(buffer);

  if (buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) return new TextDecoder('utf-8').decode(buffer.subarray(3));
  if (buffer[0] === 0xff && buffer[1] === 0xfe) return new TextDecoder('utf-16le').decode(buffer.subarray(2));
  if (buffer[0] === 0xfe && buffer[1] === 0xff) return new TextDecoder('utf-16be').decode(buffer.subarray(2));
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    return new TextDecoder('windows-1252').decode(buffer);
  }
}

export interface PluginFsOptions {
  pluginId: string;
  allowLibraryRead: boolean;
  /** Current library folders (read on every call so new libraries apply immediately). */
  libraryRoots: () => string[];
  pluginDir: string;
  dataDir: string;
}

class FsPermissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FsPermissionError';
  }
}

export function createPluginFs(options: PluginFsOptions): PluginFileSystem {
  const { pluginId, pluginDir, dataDir } = options;

  async function realpathOrSelf(p: string): Promise<string> {
    try {
      return await fs.realpath(p);
    } catch {
      return p;
    }
  }

  async function assertReadable(target: string): Promise<string> {
    if (typeof target !== 'string' || !path.isAbsolute(target)) {
      throw new FsPermissionError(`Plugin "${pluginId}": paths must be absolute (got "${target}")`);
    }
    const resolved = path.resolve(target);
    const real = await realpathOrSelf(resolved);
    const roots = [pluginDir, dataDir, ...(options.allowLibraryRead ? options.libraryRoots() : [])];
    for (const root of roots) {
      const realRoot = await realpathOrSelf(root);
      if ((isPathInside(resolved, root) || isPathInside(resolved, realRoot)) && (isPathInside(real, realRoot) || isPathInside(real, root))) {
        return resolved;
      }
    }
    const hint = options.allowLibraryRead
      ? 'it is outside every configured library folder'
      : 'the manifest does not request "permissions.filesystem": "library-read"';
    throw new FsPermissionError(`Plugin "${pluginId}" may not read "${resolved}": ${hint}`);
  }

  function dataPath(relativePath: string): string {
    const resolved = path.resolve(dataDir, relativePath);
    if (!isPathInside(resolved, dataDir) || resolved === path.resolve(dataDir)) {
      throw new FsPermissionError(`Plugin "${pluginId}": "${relativePath}" escapes the plugin data folder`);
    }
    return resolved;
  }

  const toEntry = (p: string, st: import('node:fs').Stats): FileEntry => ({
    name: path.basename(p),
    path: p,
    isFile: st.isFile(),
    isDirectory: st.isDirectory(),
    size: st.size,
    mtimeMs: st.mtimeMs,
  });

  async function readLimited(p: string, maxBytes: number): Promise<Buffer> {
    const st = await fs.stat(p);
    if (st.size > maxBytes) throw new Error(`"${p}" is larger than ${maxBytes} bytes`);
    return fs.readFile(p);
  }

  return {
    async exists(p) {
      const resolved = await assertReadable(p);
      try {
        await fs.access(resolved);
        return true;
      } catch {
        return false;
      }
    },

    async stat(p) {
      const resolved = await assertReadable(p);
      try {
        return toEntry(resolved, await fs.stat(resolved));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw err;
      }
    },

    async list(dir) {
      const resolved = await assertReadable(dir);
      const dirents = await fs.readdir(resolved, { withFileTypes: true });
      const entries = await Promise.all(
        dirents.map(async (d) => {
          const full = path.join(resolved, d.name);
          try {
            return toEntry(full, await fs.stat(full));
          } catch {
            return null; // broken symlink or vanished file
          }
        }),
      );
      return entries.filter((e): e is FileEntry => e !== null).sort((a, b) => a.name.localeCompare(b.name));
    },

    async readText(p, opts = {}) {
      const resolved = await assertReadable(p);
      return decodeText(await readLimited(resolved, opts.maxBytes ?? DEFAULT_MAX_TEXT), opts.encoding ?? 'auto');
    },

    async readBytes(p, opts = {}) {
      const resolved = await assertReadable(p);
      return new Uint8Array(await readLimited(resolved, opts.maxBytes ?? DEFAULT_MAX_BYTES));
    },

    async readData(relativePath) {
      try {
        return new Uint8Array(await fs.readFile(dataPath(relativePath)));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw err;
      }
    },

    async writeData(relativePath, data) {
      const target = dataPath(relativePath);
      await fs.mkdir(path.dirname(target), { recursive: true });
      const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
      await fs.writeFile(tmp, data);
      await fs.rename(tmp, target);
      return target;
    },

    async removeData(relativePath) {
      await fs.rm(dataPath(relativePath), { recursive: true, force: true });
    },
  };
}
