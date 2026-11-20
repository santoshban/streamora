import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Logger } from '../lib/logger.js';
import { isPathInside } from '../lib/paths.js';
import { IMAGE_EXTENSIONS } from '../media/extensions.js';

const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 20_000;

const EXT_BY_TYPE: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/svg+xml': '.svg',
  'image/avif': '.avif',
};
const TYPE_BY_EXT: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.tbn': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.avif': 'image/avif',
};

export type ArtworkScope = 'item' | 'season' | 'episode';

const refHash = (ref: string) => createHash('sha1').update(ref).digest('hex');

/**
 * Browser URL for an artwork reference. The reference itself (a TMDB URL or a
 * local file path) never reaches the browser; the hash makes the URL change
 * when the artwork does, so it can be cached forever.
 */
export function artworkUrl(scope: ArtworkScope, id: number, kind: string, ref: string | null | undefined): string | null {
  return ref ? `/api/artwork/${scope}/${id}/${kind}?v=${refHash(ref).slice(0, 10)}` : null;
}

export interface ResolvedArtwork {
  file: string;
  contentType: string;
  /** Remote images are immutable once cached; local files may be replaced. */
  immutable: boolean;
}

/**
 * Serves artwork: local sidecar images straight from library folders, remote
 * images through a disk cache so posters keep working offline.
 */
export class ArtworkService {
  private readonly dir: string;
  private readonly inflight = new Map<string, Promise<ResolvedArtwork>>();

  constructor(
    cacheDir: string,
    private readonly libraryRoots: () => string[],
    private readonly log: Logger,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.dir = path.join(cacheDir, 'artwork');
    fs.mkdirSync(this.dir, { recursive: true });
  }

  async resolve(ref: string): Promise<ResolvedArtwork | null> {
    if (/^https?:\/\//i.test(ref)) return this.remote(ref);
    return this.local(ref);
  }

  private async local(ref: string): Promise<ResolvedArtwork | null> {
    const file = path.resolve(ref);
    const ext = path.extname(file).toLowerCase();
    if (!IMAGE_EXTENSIONS.has(ext) || !TYPE_BY_EXT[ext]) return null;
    // Only images inside a library folder: artwork refs come from NFO files, which anyone can edit.
    if (!this.libraryRoots().some((root) => isPathInside(file, root))) return null;
    const st = await fs.promises.stat(file).catch(() => null);
    return st?.isFile() ? { file, contentType: TYPE_BY_EXT[ext]!, immutable: false } : null;
  }

  private async remote(url: string): Promise<ResolvedArtwork> {
    const key = refHash(url);
    for (const [ext, type] of Object.entries(EXT_BY_TYPE).map(([t, e]) => [e, t] as const)) {
      const file = path.join(this.dir, key + ext);
      if (fs.existsSync(file)) return { file, contentType: type, immutable: true };
    }
    let pending = this.inflight.get(key);
    if (!pending) {
      pending = this.download(url, key).finally(() => this.inflight.delete(key));
      this.inflight.set(key, pending);
    }
    return pending;
  }

  private async download(url: string, key: string): Promise<ResolvedArtwork> {
    const res = await this.fetchImpl(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: 'follow' });
    if (!res.ok) throw new Error(`Artwork request failed: HTTP ${res.status}`);
    const type = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
    const ext = EXT_BY_TYPE[type];
    if (!ext) throw new Error(`Not an image (${type || 'unknown type'})`);
    const declared = Number(res.headers.get('content-length') ?? 0);
    if (declared > MAX_IMAGE_BYTES) throw new Error('Image too large');
    const body = Buffer.from(await res.arrayBuffer());
    if (body.length > MAX_IMAGE_BYTES) throw new Error('Image too large');

    const file = path.join(this.dir, key + ext);
    const temp = `${file}.${process.pid}.tmp`;
    await fs.promises.writeFile(temp, body);
    await fs.promises.rename(temp, file);
    this.log.debug({ url, bytes: body.length }, 'Cached artwork');
    return { file, contentType: type, immutable: true };
  }
}
