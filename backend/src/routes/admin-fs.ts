import type { Dirent } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { requireAdmin } from '../lib/auth.js';
import { badRequest, HttpError } from '../lib/errors.js';
import { parseOrThrow } from '../lib/validation.js';
import { isSkippedDir, isVideoFile } from '../media/extensions.js';

const MAX_ENTRIES = 2000;
const querySchema = z.object({ path: z.string().trim().max(4096).optional() });

const SYSTEM_DIRS = new Set(['$recycle.bin', 'system volume information', 'recovery', 'config.msi', 'msocache', 'proc', 'sys', 'dev']);

export interface FolderEntry {
  name: string;
  path: string;
}

/** Starting points for the folder picker: drives on Windows, common mount points elsewhere. */
async function roots(): Promise<FolderEntry[]> {
  if (process.platform === 'win32') {
    const letters = 'CDEFGHIJKLMNOPQRSTUVWXYZAB'.split('');
    const found = await Promise.all(
      letters.map(async (l) => ((await fs.stat(`${l}:\\`).catch(() => null))?.isDirectory() ? `${l}:\\` : null)),
    );
    return found.filter((d): d is string => !!d).map((d) => ({ name: d.slice(0, 2), path: d }));
  }
  const candidates = ['/', os.homedir(), '/mnt', '/media', '/srv', '/data', '/Volumes'];
  const out: FolderEntry[] = [];
  for (const c of candidates) {
    if (out.some((o) => o.path === c)) continue;
    if ((await fs.stat(c).catch(() => null))?.isDirectory()) out.push({ name: c === '/' ? '/ (root)' : c, path: c });
  }
  return out;
}

/**
 * Admin folder browser used by the "Add library" dialog. Lists sub-folders
 * only (never file contents), plus how many videos sit directly inside, so
 * the admin can tell they picked the right place.
 */
export const adminFsRoutes: FastifyPluginAsync = async (app) => {
  app.get('/admin/fs', { preHandler: requireAdmin }, async (request) => {
    const query = parseOrThrow(querySchema, request.query, 'folder');
    if (!query.path) return { path: null, parent: null, separator: path.sep, entries: await roots(), videoCount: 0 };

    if (!path.isAbsolute(query.path)) throw badRequest('Folder must be an absolute path');
    const dir = path.resolve(query.path);
    let entries: Dirent[];
    try {
      const st = await fs.stat(dir);
      if (!st.isDirectory()) throw badRequest(`"${dir}" is not a folder`);
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (err) {
      if (err instanceof HttpError) throw err;
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') throw new HttpError(404, `"${dir}" does not exist`, 'NOT_FOUND');
      if (code === 'EACCES' || code === 'EPERM') throw new HttpError(403, `No permission to read "${dir}"`, 'FORBIDDEN');
      throw err;
    }

    const folders: FolderEntry[] = [];
    let videoCount = 0;
    for (const e of entries) {
      let isDir = e.isDirectory();
      if (e.isSymbolicLink()) isDir = !!(await fs.stat(path.join(dir, e.name)).catch(() => null))?.isDirectory();
      if (isDir) {
        if (!isSkippedDir(e.name) && !SYSTEM_DIRS.has(e.name.toLowerCase())) folders.push({ name: e.name, path: path.join(dir, e.name) });
      } else if (isVideoFile(e.name)) {
        videoCount++;
      }
    }
    folders.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
    const parent = path.dirname(dir);
    return {
      path: dir,
      parent: parent === dir ? null : parent,
      separator: path.sep,
      entries: folders.slice(0, MAX_ENTRIES),
      truncated: folders.length > MAX_ENTRIES,
      videoCount,
    };
  });
};
