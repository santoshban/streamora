import path from 'node:path';
import type { LibraryType } from '@streamora/plugin-sdk';
import {
  matchKeyOf,
  normalizeTitle,
  parseBareEpisode,
  parseName,
  parseSeasonFolder,
  type ParsedName,
} from '../media/parse.js';
import { pathKey } from './walk.js';

export interface ItemIdentity {
  title: string;
  year?: number;
  matchKey: string;
  /** Movie folder / show root, `null` for loose files in the library root. */
  folderPath: string | null;
  /** Ids embedded in folder or file names (`{tmdb-603}`). */
  externalIds?: Record<string, string>;
}

export type FileIdentity =
  | { kind: 'movie'; item: ItemIdentity }
  | {
      kind: 'show';
      item: ItemIdentity;
      season: number;
      episode: number;
      episodeEnd?: number;
      absoluteNumber?: number;
    };

export interface Identification {
  identity: FileIdentity | null;
  /** What the file name said (stored on the media file for debugging/re-matching). */
  parsed: ParsedName;
}

const samePath = (a: string, b: string) => pathKey(path.resolve(a)) === pathKey(path.resolve(b));

function mergeIds(...sources: Array<Record<string, string> | undefined>): Record<string, string> | undefined {
  const merged = Object.assign({}, ...sources.filter(Boolean)) as Record<string, string>;
  return Object.keys(merged).length ? merged : undefined;
}

function identifyMovie(file: string, root: string): Identification {
  const dir = path.dirname(file);
  const stem = path.basename(file, path.extname(file));
  const fromFile = parseName(path.basename(file), 'movie');
  const loose = samePath(dir, root);
  const fromFolder = loose ? undefined : parseName(path.basename(dir), 'movie');

  // A "Title (Year)" folder names the movie, unless the file clearly names a different one
  // (collection or genre folders holding several films).
  const folderNamesIt =
    !!fromFolder?.title && fromFolder.year !== undefined && (fromFile.year === undefined || fromFile.year === fromFolder.year);
  const chosen = folderNamesIt ? fromFolder! : fromFile;
  const title = chosen.title ?? fromFile.title ?? fromFolder?.title ?? stem;
  const year = chosen.year ?? (folderNamesIt ? undefined : fromFile.year);

  const folderIsMovie =
    !loose &&
    (folderNamesIt || (!!fromFolder?.title && normalizeTitle(fromFolder.title) === normalizeTitle(title)));

  return {
    parsed: fromFile,
    identity: {
      kind: 'movie',
      item: {
        title,
        year,
        matchKey: matchKeyOf(title, year),
        folderPath: folderIsMovie ? dir : null,
        externalIds: mergeIds(folderIsMovie ? fromFolder?.externalIds : undefined, fromFile.externalIds),
      },
    },
  };
}

function identifyEpisode(file: string, root: string, anime: boolean): Identification {
  const name = path.basename(file);
  const parts = path.relative(root, file).split(/[\\/]/);
  const showFolder = parts.length >= 2 ? path.join(root, parts[0]!) : null;
  const seasonFromFolder = parts.length >= 3 ? parseSeasonFolder(parts[parts.length - 2]!) : undefined;

  let parsed = parseName(name, 'show', { absolute: anime });
  let season: number | undefined;
  let episode: number | undefined;
  let episodeEnd: number | undefined;
  let absoluteNumber: number | undefined;

  const take = (p: ParsedName): boolean => {
    if (p.season !== undefined && p.episode !== undefined) {
      season = p.season;
      episode = p.episode;
      episodeEnd = p.episodeEnd;
      return true;
    }
    if (p.airDate) {
      // Daily shows: season = year, episode = MMDD.
      season = Number(p.airDate.slice(0, 4));
      episode = Number(p.airDate.slice(5, 7) + p.airDate.slice(8, 10));
      return true;
    }
    if (p.absoluteEpisode !== undefined) {
      season = seasonFromFolder ?? 1;
      episode = p.absoluteEpisode;
      if (seasonFromFolder === undefined) absoluteNumber = p.absoluteEpisode;
      return true;
    }
    return false;
  };

  if (!take(parsed)) {
    const bare = seasonFromFolder !== undefined ? parseBareEpisode(name) : undefined;
    if (bare) {
      season = seasonFromFolder;
      episode = bare.episode;
      episodeEnd = bare.episodeEnd;
    } else if (!anime) {
      // Fallback for "Show - 05.mkv" style names outside anime libraries.
      const fallback = parseName(name, 'show', { absolute: true });
      if (take(fallback)) parsed = fallback;
    }
  }
  if (season === undefined || episode === undefined) return { identity: null, parsed };

  let item: ItemIdentity | null = null;
  if (showFolder) {
    const folder = parseName(parts[0]!, 'movie');
    const title = folder.title ?? parts[0]!;
    item = { title, year: folder.year, matchKey: matchKeyOf(title, folder.year), folderPath: showFolder, externalIds: folder.externalIds };
  } else if (parsed.title) {
    // Loose episode files in the library root: the show comes from the file name.
    const year = parsed.airDate ? undefined : parsed.year;
    item = { title: parsed.title, year, matchKey: matchKeyOf(parsed.title, year), folderPath: null };
  }
  if (!item) return { identity: null, parsed };

  return {
    parsed,
    identity: { kind: 'show', item, season, episode, episodeEnd, absoluteNumber },
  };
}

/** Works out which movie, or which show/season/episode, a video file is. */
export function identifyFile(file: string, root: string, libraryType: LibraryType): Identification {
  return libraryType === 'movies' ? identifyMovie(file, root) : identifyEpisode(file, root, libraryType === 'anime');
}
