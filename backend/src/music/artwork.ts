import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Logger } from '../lib/logger.js';
import { isPathInside } from '../lib/paths.js';
import { runProcess } from '../lib/process.js';
import { IMAGE_EXTENSIONS } from '../media/extensions.js';

/** Longest side of the cached covers: sharp on the player page, small enough for grids. */
const MAX_SIZE = 900;
/** Folder images up to this size are served as they are when ffmpeg is missing. */
const MAX_DIRECT_BYTES = 8 * 1024 * 1024;
const CONCURRENCY = 3;

const TYPE_BY_EXT: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.tbn': 'image/jpeg',
};

export interface CoverFile {
  file: string;
  contentType: string;
}

/** Preferred cover names in an album folder, best first. */
const COVER_NAMES = ['cover', 'folder', 'front', 'album', 'albumart', 'albumartlarge', 'thumb'];
/** Preferred artist image names in an artist folder. */
const ARTIST_NAMES = ['artist', 'folder', 'photo', 'poster'];

async function imagesIn(dir: string): Promise<string[]> {
  const entries = await fs.promises.readdir(dir, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((e) => e.isFile() && IMAGE_EXTENSIONS.has(path.extname(e.name).toLowerCase()) && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b));
}

function pick(names: string[], preferred: string[]): string | undefined {
  for (const want of preferred) {
    const hit = names.find((n) => path.basename(n, path.extname(n)).toLowerCase() === want);
    if (hit) return hit;
  }
  return undefined;
}

/** `cover.jpg`/`folder.jpg`/… in an album folder; otherwise its only image, or one named after the album. */
export async function findAlbumCover(dirs: string[], albumTitle: string): Promise<string | null> {
  for (const dir of dirs) {
    const names = await imagesIn(dir);
    if (!names.length) continue;
    const preferred = pick(names, COVER_NAMES);
    if (preferred) return path.join(dir, preferred);
    const key = albumTitle.toLowerCase();
    const named = names.find((n) => path.basename(n, path.extname(n)).toLowerCase() === key);
    if (named) return path.join(dir, named);
    if (names.length === 1) return path.join(dir, names[0]!);
    const scan = names.find((n) => /front|cover/i.test(n));
    if (scan) return path.join(dir, scan);
  }
  return null;
}

export async function findArtistImage(dir: string): Promise<string | null> {
  const preferred = pick(await imagesIn(dir), ARTIST_NAMES);
  return preferred ? path.join(dir, preferred) : null;
}

/**
 * Serves album covers and artist images. Folder images and pictures embedded
 * in tracks are scaled down once with ffmpeg and kept in the cache folder.
 */
export class MusicArtwork {
  private readonly dir: string;
  private readonly inflight = new Map<string, Promise<CoverFile | null>>();
  private running = 0;
  private readonly queue: Array<() => void> = [];

  constructor(
    cacheDir: string,
    private readonly ffmpegPath: () => string | null,
    private readonly libraryRoots: () => string[],
    private readonly log: Logger,
  ) {
    this.dir = path.join(cacheDir, 'music-art');
    fs.mkdirSync(this.dir, { recursive: true });
  }

  /**
   * `ref` is a folder image path or `embedded:<track path>`. Returns null when
   * there is nothing to show (missing file, no picture, ffmpeg unavailable).
   */
  async resolve(ref: string): Promise<CoverFile | null> {
    const embedded = ref.startsWith('embedded:');
    const source = path.resolve(embedded ? ref.slice('embedded:'.length) : ref);
    // Only files inside a library folder: never let a stored path read anything else.
    if (!this.libraryRoots().some((root) => isPathInside(source, root))) return null;
    const st = await fs.promises.stat(source).catch(() => null);
    if (!st?.isFile()) return null;

    const ffmpeg = this.ffmpegPath();
    if (!ffmpeg) {
      const type = TYPE_BY_EXT[path.extname(source).toLowerCase()];
      return !embedded && type && st.size <= MAX_DIRECT_BYTES ? { file: source, contentType: type } : null;
    }

    const key = createHash('sha1').update(`${ref}|${st.size}|${Math.floor(st.mtimeMs)}`).digest('hex');
    const out = path.join(this.dir, `${key}.jpg`);
    if (fs.existsSync(out)) return { file: out, contentType: 'image/jpeg' };
    const missing = path.join(this.dir, `${key}.none`);
    if (fs.existsSync(missing)) return null;

    let pending = this.inflight.get(key);
    if (!pending) {
      pending = this.limit(() => this.render(ffmpeg, source, out, missing)).finally(() => this.inflight.delete(key));
      this.inflight.set(key, pending);
    }
    return pending;
  }

  private async render(ffmpeg: string, source: string, out: string, missing: string): Promise<CoverFile | null> {
    const temp = `${out}.${process.pid}.tmp.jpg`;
    const result = await runProcess(
      ffmpeg,
      [
        '-hide_banner', '-v', 'error', '-y',
        '-i', source,
        '-map', '0:v:0', '-frames:v', '1',
        '-vf', `scale='min(${MAX_SIZE},iw)':'min(${MAX_SIZE},ih)':force_original_aspect_ratio=decrease:flags=lanczos`,
        '-c:v', 'mjpeg', '-q:v', '3', '-f', 'image2',
        temp,
      ],
      { timeoutMs: 30_000, maxOutputBytes: 1024 },
    ).catch((err: unknown) => ({ code: -1, stdout: Buffer.alloc(0), stderr: String(err) }));

    const ok = result.code === 0 && (await fs.promises.stat(temp).catch(() => null))?.size;
    if (!ok) {
      await fs.promises.rm(temp, { force: true });
      // Remember "no picture" so every grid load doesn't run ffmpeg again.
      await fs.promises.writeFile(missing, '').catch(() => undefined);
      this.log.debug({ source, stderr: result.stderr.slice(-300) }, 'No artwork in file');
      return null;
    }
    await fs.promises.rename(temp, out);
    return { file: out, contentType: 'image/jpeg' };
  }

  private async limit<T>(task: () => Promise<T>): Promise<T> {
    if (this.running >= CONCURRENCY) await new Promise<void>((resolve) => this.queue.push(resolve));
    this.running++;
    try {
      return await task();
    } finally {
      this.running--;
      this.queue.shift()?.();
    }
  }
}
