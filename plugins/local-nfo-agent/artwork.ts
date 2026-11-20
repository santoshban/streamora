import path from 'node:path';
import type { Artwork, FileEntry, PluginFileSystem } from '@streamora/plugin-sdk';

export const VIDEO_EXTENSIONS = new Set([
  '.mkv', '.mp4', '.m4v', '.avi', '.mov', '.wmv', '.webm', '.ts', '.m2ts', '.mts', '.mpg', '.mpeg', '.flv', '.ogv', '.3gp',
]);
const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp'];
const EXTRA_VIDEO = /(^|[\s._-])(sample|trailer|featurette|behindthescenes|deleted|extra)s?([\s._-]|$)/i;

export const stem = (file: string) => path.basename(file, path.extname(file));
const norm = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p);

/** Memoised directory listings for the duration of one capability call. */
export class DirCache {
  private readonly listings = new Map<string, Promise<FileEntry[]>>();
  constructor(private readonly fs: PluginFileSystem) {}

  list(dir: string): Promise<FileEntry[]> {
    const key = norm(dir);
    let pending = this.listings.get(key);
    if (!pending) {
      pending = this.fs.list(dir).catch(() => []);
      this.listings.set(key, pending);
    }
    return pending;
  }

  /** Case-insensitive lookup of `<base><ext>` for any of the image/given extensions. */
  async find(dir: string, bases: string[], extensions = IMAGE_EXTENSIONS): Promise<string | undefined> {
    const entries = await this.list(dir);
    const byName = new Map(entries.filter((e) => e.isFile).map((e) => [e.name.toLowerCase(), e.path]));
    for (const base of bases) {
      for (const ext of extensions) {
        const hit = byName.get(`${base}${ext}`.toLowerCase());
        if (hit) return hit;
      }
    }
    return undefined;
  }
}

/**
 * True when every (non-extra) video in `dir` belongs to this title, so
 * folder-level art such as `poster.jpg` can safely be attributed to it.
 */
export async function isDedicatedFolder(dirs: DirCache, dir: string, ownFiles: string[]): Promise<boolean> {
  const own = new Set(ownFiles.map(norm));
  const videos = (await dirs.list(dir)).filter(
    (e) => e.isFile && VIDEO_EXTENSIONS.has(path.extname(e.name).toLowerCase()) && !EXTRA_VIDEO.test(stem(e.name)),
  );
  return videos.length > 0 && videos.every((v) => own.has(norm(v.path)));
}

/** Artwork for a movie: `<video>-poster.jpg` style first, then folder-level names if the folder is dedicated. */
export async function findMovieArtwork(dirs: DirCache, filePaths: string[]): Promise<Artwork> {
  const art: Artwork = {};
  for (const file of filePaths) {
    const dir = path.dirname(file);
    const base = stem(file);
    art.poster ??= await dirs.find(dir, [`${base}-poster`, `${base}`]);
    art.backdrop ??= await dirs.find(dir, [`${base}-fanart`, `${base}-backdrop`]);
    art.logo ??= await dirs.find(dir, [`${base}-clearlogo`, `${base}-logo`], ['.png', '.svg', '.webp']);
    art.thumb ??= await dirs.find(dir, [`${base}-landscape`, `${base}-thumb`]);
  }

  const folders = [...new Set(filePaths.map((f) => path.dirname(f)))];
  for (const dir of folders) {
    if (!(await isDedicatedFolder(dirs, dir, filePaths))) continue;
    Object.assign(art, { ...(await findFolderArtwork(dirs, dir)), ...stripEmpty(art) });
  }
  return stripEmpty(art);
}

/** Folder-level artwork names shared by movie folders and show roots. */
export async function findFolderArtwork(dirs: DirCache, dir: string): Promise<Artwork> {
  return stripEmpty({
    poster: await dirs.find(dir, ['poster', 'folder', 'cover', 'movie', 'show']),
    backdrop: await dirs.find(dir, ['fanart', 'backdrop', 'background', 'art']),
    logo: await dirs.find(dir, ['clearlogo', 'logo'], ['.png', '.svg', '.webp']),
    thumb: await dirs.find(dir, ['landscape', 'thumb']),
  });
}

/** `season01-poster.jpg` / `season1-poster.jpg` / `season-specials-poster.jpg` in the show root, or `poster.jpg` inside the season folder. */
export async function findSeasonPoster(
  dirs: DirCache,
  showRoot: string | undefined,
  seasonFolder: string | undefined,
  seasonNumber: number,
): Promise<string | undefined> {
  if (showRoot) {
    const padded = String(seasonNumber).padStart(2, '0');
    const names = seasonNumber === 0
      ? ['season-specials-poster', 'season00-poster', 'season0-poster']
      : [`season${padded}-poster`, `season${seasonNumber}-poster`, `season${padded}`];
    const hit = await dirs.find(showRoot, names);
    if (hit) return hit;
  }
  if (seasonFolder && (!showRoot || norm(seasonFolder) !== norm(showRoot))) {
    return dirs.find(seasonFolder, ['poster', 'folder', 'cover']);
  }
  return undefined;
}

export async function findEpisodeThumb(dirs: DirCache, file: string): Promise<string | undefined> {
  const base = stem(file);
  return dirs.find(path.dirname(file), [`${base}-thumb`, `${base}-landscape`, base]);
}

function stripEmpty(art: Artwork): Artwork {
  const out: Artwork = {};
  for (const key of ['poster', 'backdrop', 'logo', 'thumb'] as const) if (art[key]) out[key] = art[key];
  return out;
}
