import path from 'node:path';
import type {
  CrewMember,
  EpisodeMetadata,
  MetadataMatchRequest,
  MetadataMatchResult,
  PluginContext,
  PluginFactory,
  SeasonMetadata,
} from '@streamora/plugin-sdk';
import {
  DirCache,
  findEpisodeThumb,
  findFolderArtwork,
  findMovieArtwork,
  findSeasonPoster,
  stem,
} from './artwork.js';
import { parseNfo, type ParsedNfo } from './nfo-parser.js';

const MAX_NFO_BYTES = 2 * 1024 * 1024;

async function readNfo(ctx: PluginContext, dirs: DirCache, file: string): Promise<ParsedNfo[] | null> {
  const dir = path.dirname(file);
  const wanted = path.basename(file).toLowerCase();
  const entry = (await dirs.list(dir)).find((e) => e.isFile && e.name.toLowerCase() === wanted);
  if (!entry) return null;
  try {
    const parsed = parseNfo(await ctx.fs.readText(entry.path, { maxBytes: MAX_NFO_BYTES }));
    return parsed.length ? parsed : null;
  } catch (err) {
    ctx.log.warn('Could not read NFO file', { file: entry.path, error: (err as Error).message });
    return null;
  }
}

function crewFrom(nfo: ParsedNfo): CrewMember[] {
  return [
    ...nfo.directors.map((name) => ({ name, job: 'Director' })),
    ...nfo.writers.map((name) => ({ name, job: 'Writer' })),
  ];
}

function toMetadata(nfo: ParsedNfo, kind: 'movie' | 'show', passIds: boolean): MetadataMatchResult {
  return {
    kind,
    confidence: 1,
    title: nfo.title,
    originalTitle: nfo.originalTitle,
    sortTitle: nfo.sortTitle,
    year: nfo.year,
    releaseDate: nfo.releaseDate,
    overview: nfo.overview,
    tagline: nfo.tagline,
    runtimeMinutes: nfo.runtimeMinutes,
    contentRating: nfo.contentRating,
    rating: nfo.rating,
    status: nfo.status,
    genres: nfo.genres,
    studios: nfo.studios,
    cast: nfo.actors,
    crew: crewFrom(nfo),
    artwork: { poster: nfo.posterUrls[0], backdrop: nfo.fanartUrls[0] },
    externalIds: passIds ? nfo.externalIds : {},
  };
}

const hasContent = (m: MetadataMatchResult) =>
  !!(m.title || m.overview || Object.values(m.artwork ?? {}).some(Boolean) || Object.keys(m.externalIds ?? {}).length);

const createPlugin: PluginFactory = (ctx) => {
  const readNfoFiles = ctx.settings.readNfo !== false;
  const readArtwork = ctx.settings.readArtwork !== false;
  const passIds = ctx.settings.passIds !== false;

  async function matchMovie(request: MetadataMatchRequest): Promise<MetadataMatchResult | null> {
    const dirs = new DirCache(ctx.fs);
    let nfo: ParsedNfo | undefined;

    if (readNfoFiles) {
      // <video>.nfo next to any version, then movie.nfo in its folder.
      const candidates = [
        ...request.filePaths.map((f) => path.join(path.dirname(f), `${stem(f)}.nfo`)),
        ...[...new Set(request.filePaths.map((f) => path.dirname(f)))].map((d) => path.join(d, 'movie.nfo')),
      ];
      for (const candidate of candidates) {
        nfo = (await readNfo(ctx, dirs, candidate))?.find((n) => n.kind === 'movie' || n.kind === 'url-only');
        if (nfo) break;
      }
    }

    const result: MetadataMatchResult = nfo ? toMetadata(nfo, 'movie', passIds) : { kind: 'movie', confidence: 1 };
    if (readArtwork) {
      const local = await findMovieArtwork(dirs, request.filePaths);
      result.artwork = { ...result.artwork, ...local };
    }
    return hasContent(result) ? result : null;
  }

  async function matchShow(request: MetadataMatchRequest): Promise<MetadataMatchResult | null> {
    const root = request.folderPath;
    if (!root) return null;
    const dirs = new DirCache(ctx.fs);

    const nfo = readNfoFiles
      ? (await readNfo(ctx, dirs, path.join(root, 'tvshow.nfo')))?.find((n) => n.kind === 'tvshow' || n.kind === 'url-only')
      : undefined;
    const result: MetadataMatchResult = nfo ? toMetadata(nfo, 'show', passIds) : { kind: 'show', confidence: 1 };
    if (readArtwork) result.artwork = { ...result.artwork, ...(await findFolderArtwork(dirs, root)) };
    return hasContent(result) ? result : null;
  }

  return {
    metadata: {
      match: (request) => (request.kind === 'movie' ? matchMovie(request) : matchShow(request)),

      async getSeason(request): Promise<SeasonMetadata | null> {
        const dirs = new DirCache(ctx.fs);
        const showRoot = request.show.folderPath;
        const firstFile = request.episodes.flatMap((e) => e.filePaths)[0];
        const seasonFolder = firstFile ? path.dirname(firstFile) : undefined;

        const season: SeasonMetadata = { seasonNumber: request.seasonNumber };
        if (readArtwork) season.poster = await findSeasonPoster(dirs, showRoot, seasonFolder, request.seasonNumber);
        if (readNfoFiles && seasonFolder && seasonFolder !== showRoot) {
          const seasonNfo = (await readNfo(ctx, dirs, path.join(seasonFolder, 'season.nfo')))?.find((n) => n.kind === 'season');
          if (seasonNfo) {
            season.title = seasonNfo.title;
            season.overview = seasonNfo.overview;
            season.airDate = seasonNfo.releaseDate;
          }
        }

        const episodes: EpisodeMetadata[] = [];
        for (const ep of request.episodes) {
          const meta: EpisodeMetadata = { seasonNumber: ep.seasonNumber, episodeNumber: ep.episodeNumber };
          for (const file of ep.filePaths) {
            if (readNfoFiles && !meta.title) {
              const entries = (await readNfo(ctx, dirs, path.join(path.dirname(file), `${stem(file)}.nfo`))) ?? [];
              const details = entries.filter((n) => n.kind === 'episodedetails');
              // Multi-episode files hold one <episodedetails> per episode.
              const nfo =
                details.find((n) => n.season === ep.seasonNumber && n.episode === ep.episodeNumber) ??
                (details.length === 1 ? details[0] : undefined);
              if (nfo) {
                Object.assign(meta, {
                  title: nfo.title,
                  overview: nfo.overview,
                  airDate: nfo.releaseDate,
                  runtimeMinutes: nfo.runtimeMinutes,
                  rating: nfo.rating,
                  still: nfo.posterUrls[0],
                  externalIds: passIds ? nfo.externalIds : undefined,
                });
              }
            }
            if (readArtwork) {
              const thumb = await findEpisodeThumb(dirs, file);
              if (thumb) meta.still = thumb;
            }
          }
          if (Object.keys(meta).some((k) => k !== 'seasonNumber' && k !== 'episodeNumber' && meta[k as keyof EpisodeMetadata] !== undefined)) {
            episodes.push(meta);
          }
        }
        if (episodes.length) season.episodes = episodes;

        const hasData = season.poster || season.title || season.overview || episodes.length;
        return hasData ? season : null;
      },
    },
  };
};

export default createPlugin;
