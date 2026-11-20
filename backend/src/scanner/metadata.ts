import { asc, eq } from 'drizzle-orm';
import type { EpisodeMetadata, ExternalIds, MediaMetadata } from '@streamora/plugin-sdk';
import type { DB } from '../db/client.js';
import { episodes, mediaFiles, mediaItems, seasons, type Library, type MediaItem } from '../db/schema.js';
import type { EventBus } from '../lib/events.js';
import type { Logger } from '../lib/logger.js';
import { normalizeTitle, sortTitleOf } from '../media/parse.js';
import type { MetadataService } from '../plugins/services/metadata.js';

export interface MetadataDeps {
  db: DB;
  metadata: MetadataService;
  events: EventBus;
  log: Logger;
}

export interface RefreshOptions {
  signal?: AbortSignal;
  /** Ignore ids from the previous match and search again from the file names. */
  rematch?: boolean;
  /** Ids chosen in the "Fix match" dialog. */
  externalIds?: ExternalIds;
  /** Fetch season/episode details for these seasons (`all` by default for shows). */
  seasons?: number[] | 'all';
}

const cleanIds = (ids: ExternalIds | undefined): Record<string, string> =>
  Object.fromEntries(Object.entries(ids ?? {}).filter((e): e is [string, string] => typeof e[1] === 'string' && e[1] !== ''));

/**
 * Title/year the file names gave, independent of earlier matches. The key is
 * normalised (`the matrix|1999`), so the original casing is recovered from a
 * file's parsed name when one agrees with it.
 */
function parsedIdentity(db: DB, item: MediaItem): { title: string; year?: number } {
  const [keyTitle = '', year] = item.matchKey.split('|');
  const parsedTitles = db
    .select({ parsed: mediaFiles.parsed })
    .from(mediaFiles)
    .where(eq(mediaFiles.mediaItemId, item.id))
    .all()
    .map((f) => f.parsed.title)
    .filter((t): t is string => typeof t === 'string');
  const title = parsedTitles.find((t) => normalizeTitle(t) === keyTitle) ?? (keyTitle || item.title);
  return { title, year: year ? Number(year) : undefined };
}

function hintIds(db: DB, itemId: number): Record<string, string> {
  const files = db.select({ parsed: mediaFiles.parsed }).from(mediaFiles).where(eq(mediaFiles.mediaItemId, itemId)).all();
  const ids: Record<string, string> = {};
  for (const f of files) Object.assign(ids, cleanIds(f.parsed.externalIds as ExternalIds | undefined));
  return ids;
}

function itemValues(item: MediaItem, m: MediaMetadata, sources: string[], baseIds: Record<string, string>) {
  const title = m.title ?? item.title;
  return {
    title,
    sortTitle: sortTitleOf(m.sortTitle ?? title),
    originalTitle: m.originalTitle ?? null,
    year: m.year ?? item.year,
    releaseDate: m.releaseDate ?? null,
    tagline: m.tagline ?? null,
    overview: m.overview ?? null,
    genres: m.genres ?? [],
    studios: m.studios ?? [],
    contentRating: m.contentRating ?? null,
    rating: m.rating ?? null,
    runtimeMinutes: m.runtimeMinutes ?? null,
    status: m.status ?? null,
    cast: m.cast ?? [],
    crew: m.crew ?? [],
    poster: m.artwork?.poster ?? null,
    backdrop: m.artwork?.backdrop ?? null,
    logo: m.artwork?.logo ?? null,
    thumb: m.artwork?.thumb ?? null,
    externalIds: { ...baseIds, ...cleanIds(m.externalIds) },
    metadataSources: sources,
    metadataUpdatedAt: new Date(),
  };
}

/**
 * Runs the metadata agents for one movie/show and stores the result
 * (plus season/episode details for shows). Returns the updated row.
 */
export async function refreshItemMetadata(
  deps: MetadataDeps,
  library: Library,
  item: MediaItem,
  options: RefreshOptions = {},
): Promise<MediaItem> {
  const { db, metadata } = deps;
  const files = db.select({ path: mediaFiles.path }).from(mediaFiles).where(eq(mediaFiles.mediaItemId, item.id)).all();
  const identity = parsedIdentity(db, item);
  const manual = options.externalIds ? cleanIds(options.externalIds) : undefined;
  const externalIds = manual ?? (options.rematch ? hintIds(db, item.id) : { ...hintIds(db, item.id), ...cleanIds(item.externalIds) });

  const outcome = await metadata.match(
    {
      kind: item.kind,
      title: options.rematch || manual ? identity.title : item.title,
      year: options.rematch || manual ? identity.year : (item.year ?? undefined),
      language: library.language,
      libraryType: library.type,
      externalIds,
      folderPath: item.folderPath ?? undefined,
      filePaths: item.kind === 'movie' ? files.map((f) => f.path) : [],
    },
    { agents: library.agents, signal: options.signal },
  );
  options.signal?.throwIfAborted();

  let updated = item;
  if (outcome.metadata) {
    updated = db
      .update(mediaItems)
      .set(itemValues(item, outcome.metadata, outcome.sources, options.rematch || manual ? externalIds : cleanIds(item.externalIds)))
      .where(eq(mediaItems.id, item.id))
      .returning()
      .get();
  } else if (outcome.errors.length === 0 || outcome.sources.length > 0) {
    // Nobody recognised it: remember the attempt so routine scans don't retry immediately.
    // (When every provider *failed* — e.g. offline — leave it for the next scan.)
    updated = db
      .update(mediaItems)
      .set({ metadataUpdatedAt: new Date(), ...(options.rematch ? { metadataSources: [] } : {}) })
      .where(eq(mediaItems.id, item.id))
      .returning()
      .get();
  }

  if (item.kind === 'show') await refreshSeasons(deps, library, updated, options.seasons ?? 'all', options.signal);
  deps.events.emit('metadata.updated', { mediaItemId: item.id });
  return updated;
}

function episodeValues(meta: EpisodeMetadata | undefined, extraTitles: string[]) {
  const title = [meta?.title, ...extraTitles].filter(Boolean).join(' / ') || null;
  return {
    title,
    overview: meta?.overview ?? null,
    still: meta?.still ?? null,
    airDate: meta?.airDate ?? null,
    runtimeMinutes: meta?.runtimeMinutes ?? null,
    rating: meta?.rating ?? null,
    externalIds: cleanIds(meta?.externalIds),
  };
}

/** Season + episode details for the seasons of a show that have files. */
export async function refreshSeasons(
  deps: MetadataDeps,
  library: Library,
  show: MediaItem,
  which: number[] | 'all',
  signal?: AbortSignal,
): Promise<void> {
  const { db, metadata } = deps;
  const rows = db.select().from(seasons).where(eq(seasons.showId, show.id)).orderBy(asc(seasons.seasonNumber)).all();
  const targets = which === 'all' ? rows : rows.filter((s) => which.includes(s.seasonNumber));

  const filesByEpisode = new Map<number, string[]>();
  for (const f of db
    .select({ episodeId: mediaFiles.episodeId, path: mediaFiles.path })
    .from(mediaFiles)
    .where(eq(mediaFiles.mediaItemId, show.id))
    .all()) {
    if (f.episodeId === null) continue;
    filesByEpisode.set(f.episodeId, [...(filesByEpisode.get(f.episodeId) ?? []), f.path]);
  }

  for (const season of targets) {
    signal?.throwIfAborted();
    const eps = db.select().from(episodes).where(eq(episodes.seasonId, season.id)).all();
    if (!eps.length) continue;

    const outcome = await metadata.getSeason(
      {
        show: {
          title: show.title,
          year: show.year ?? undefined,
          externalIds: cleanIds(show.externalIds),
          folderPath: show.folderPath ?? undefined,
        },
        seasonNumber: season.seasonNumber,
        language: library.language,
        episodes: eps.map((e) => ({
          seasonNumber: e.seasonNumber,
          episodeNumber: e.episodeNumber,
          filePaths: filesByEpisode.get(e.id) ?? [],
        })),
      },
      { agents: library.agents, signal },
    );
    signal?.throwIfAborted();
    const meta = outcome.season;
    if (!meta) continue;

    const byNumber = new Map((meta.episodes ?? []).map((e) => [e.episodeNumber, e]));
    db.transaction((tx) => {
      tx.update(seasons)
        .set({
          title: meta.title ?? null,
          overview: meta.overview ?? null,
          poster: meta.poster ?? null,
          airDate: meta.airDate ?? null,
          externalIds: cleanIds(meta.externalIds),
        })
        .where(eq(seasons.id, season.id))
        .run();
      for (const ep of eps) {
        const extra: string[] = [];
        for (let n = ep.episodeNumber + 1; n <= (ep.episodeNumberEnd ?? ep.episodeNumber); n++) {
          const t = byNumber.get(n)?.title;
          if (t) extra.push(t);
        }
        const values = episodeValues(byNumber.get(ep.episodeNumber), extra);
        if (!byNumber.has(ep.episodeNumber) && !extra.length) continue;
        tx.update(episodes).set(values).where(eq(episodes.id, ep.id)).run();
      }
    });
  }
}
