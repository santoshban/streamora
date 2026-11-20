import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** `backend/` — works from both `src/lib` (tsx) and `dist/lib` (compiled). */
export const BACKEND_ROOT = path.resolve(here, '..', '..');

/** Monorepo root (contains `plugins/`, `.env`, `data/`). */
export const REPO_ROOT = path.resolve(BACKEND_ROOT, '..');

export const MIGRATIONS_DIR = path.join(BACKEND_ROOT, 'drizzle');

/** Resolves `p` against the repo root unless it is already absolute. */
export function resolveFromRoot(p: string): string {
  return path.isAbsolute(p) ? path.normalize(p) : path.resolve(REPO_ROOT, p);
}

/**
 * True when `child` is `parent` or lives inside it. Case-insensitive on
 * Windows, where `path.relative` already normalises case.
 */
export function isPathInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
