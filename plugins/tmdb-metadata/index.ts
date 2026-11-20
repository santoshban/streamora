import type {
  CallOptions,
  MetadataMatchRequest,
  MetadataMatchResult,
  MetadataSearchResult,
  PluginFactory,
  PluginHttpError,
  SeasonMetadata,
} from '@streamora/plugin-sdk';
import { mapMovie, mapMovieSearch, mapSeason, mapShow, mapTvSearch, type ImageOptions } from './mapper.js';
import { MIN_MATCH_SCORE, parseYear, pickBest } from './match.js';
import { isNotFound, TmdbClient, TTL } from './tmdb-client.js';
import type {
  TmdbFindResult,
  TmdbMovieDetails,
  TmdbMovieSummary,
  TmdbPaged,
  TmdbSeasonDetails,
  TmdbTvDetails,
  TmdbTvSummary,
} from './types.js';

type Kind = 'movie' | 'show';

const createPlugin: PluginFactory = (ctx) => {
  const s = ctx.settings;
  const client = new TmdbClient(ctx, {
    apiBaseUrl: String(s.apiBaseUrl || 'https://api.themoviedb.org/3'),
    credential: String(s.apiKey ?? ''),
  });
  const includeAdult = s.includeAdult === true;

  const languageFor = (requested: string) => (typeof s.language === 'string' && s.language ? s.language : requested);
  const imageOptions = (language: string): ImageOptions => ({
    imageBaseUrl: String(s.imageBaseUrl || 'https://image.tmdb.org/t/p'),
    posterSize: String(s.posterSize || 'w500'),
    backdropSize: String(s.backdropSize || 'w1280'),
    language: language.split('-')[0] ?? 'en',
    region: String(s.region || 'US'),
    castLimit: typeof s.castLimit === 'number' ? s.castLimit : 20,
  });
  const imageLanguages = (language: string) => [...new Set([language.split('-')[0], 'en', 'null'])].join(',');

  /** Finds the TMDB id: known id → IMDb/TVDB lookup → scored search. */
  async function resolveId(
    kind: Kind,
    request: Pick<MetadataMatchRequest, 'title' | 'year' | 'externalIds'>,
    language: string,
    signal: AbortSignal,
  ): Promise<{ id: number; confidence: number } | null> {
    const ids = request.externalIds;
    if (ids.tmdb && /^\d+$/.test(ids.tmdb)) return { id: Number(ids.tmdb), confidence: 1 };

    const lookups: Array<[string, string | undefined]> = [
      ['imdb_id', ids.imdb && /^tt\d+$/.test(ids.imdb) ? ids.imdb : undefined],
      ['tvdb_id', kind === 'show' && ids.tvdb && /^\d+$/.test(ids.tvdb) ? ids.tvdb : undefined],
    ];
    for (const [source, value] of lookups) {
      if (!value) continue;
      const found = await client.get<TmdbFindResult>(`/find/${value}`, { external_source: source }, { signal, ttlMs: TTL.find });
      const hit = kind === 'movie' ? found.movie_results[0] : found.tv_results[0];
      if (hit) return { id: hit.id, confidence: 1 };
    }

    const title = request.title.trim();
    if (!title) return null;

    const search = async (year?: number) => {
      if (kind === 'movie') {
        const page = await client.get<TmdbPaged<TmdbMovieSummary>>(
          '/search/movie',
          { query: title, year, language, include_adult: includeAdult },
          { signal, ttlMs: TTL.search },
        );
        return page.results.map((r) => ({
          id: r.id,
          title: r.title,
          originalTitle: r.original_title,
          year: parseYear(r.release_date),
          popularity: r.popularity,
        }));
      }
      const page = await client.get<TmdbPaged<TmdbTvSummary>>(
        '/search/tv',
        { query: title, first_air_date_year: year, language, include_adult: includeAdult },
        { signal, ttlMs: TTL.search },
      );
      return page.results.map((r) => ({
        id: r.id,
        title: r.name,
        originalTitle: r.original_name,
        year: parseYear(r.first_air_date),
        popularity: r.popularity,
      }));
    };

    let candidates = await search(request.year);
    // A wrong year in the file name shouldn't hide the right title.
    if (candidates.length === 0 && request.year) candidates = await search();

    const best = pickBest(candidates, { title, year: request.year });
    if (!best || best.score < MIN_MATCH_SCORE) {
      ctx.log.debug('No confident TMDB match', { kind, title, year: request.year, bestScore: best?.score });
      return null;
    }
    return { id: best.candidate.id, confidence: Math.min(1, Math.round(best.score * 100) / 100) };
  }

  async function match(request: MetadataMatchRequest, { signal }: CallOptions): Promise<MetadataMatchResult | null> {
    const language = languageFor(request.language);
    const resolved = await resolveId(request.kind, request, language, signal);
    if (!resolved) return null;
    const options = imageOptions(language);

    try {
      if (request.kind === 'movie') {
        const details = await client.get<TmdbMovieDetails>(
          `/movie/${resolved.id}`,
          {
            language,
            append_to_response: 'credits,images,release_dates,external_ids',
            include_image_language: imageLanguages(language),
          },
          { signal, ttlMs: TTL.details },
        );
        return mapMovie(details, options, resolved.confidence);
      }
      const details = await client.get<TmdbTvDetails>(
        `/tv/${resolved.id}`,
        {
          language,
          append_to_response: 'aggregate_credits,images,content_ratings,external_ids',
          include_image_language: imageLanguages(language),
        },
        { signal, ttlMs: TTL.details },
      );
      return mapShow(details, options, resolved.confidence);
    } catch (err) {
      // A stale id (e.g. from an old NFO) should not fail the whole pipeline.
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  return {
    metadata: {
      match,

      async getSeason(request, { signal }): Promise<SeasonMetadata | null> {
        const language = languageFor(request.language);
        const resolved = await resolveId(
          'show',
          { title: request.show.title, year: request.show.year, externalIds: request.show.externalIds },
          language,
          signal,
        );
        if (!resolved) return null;
        try {
          const season = await client.get<TmdbSeasonDetails>(
            `/tv/${resolved.id}/season/${request.seasonNumber}`,
            { language },
            { signal, ttlMs: TTL.details },
          );
          return mapSeason(season, imageOptions(language));
        } catch (err) {
          if (isNotFound(err)) return null;
          throw err;
        }
      },

      async search(query, { signal }): Promise<MetadataSearchResult[]> {
        const language = languageFor(query.language);
        const options = imageOptions(language);
        if (query.kind === 'movie') {
          const page = await client.get<TmdbPaged<TmdbMovieSummary>>(
            '/search/movie',
            { query: query.query, year: query.year, language, include_adult: includeAdult },
            { signal, ttlMs: TTL.search },
          );
          return page.results.slice(0, 20).map((r) => mapMovieSearch(r, options));
        }
        const page = await client.get<TmdbPaged<TmdbTvSummary>>(
          '/search/tv',
          { query: query.query, first_air_date_year: query.year, language, include_adult: includeAdult },
          { signal, ttlMs: TTL.search },
        );
        return page.results.slice(0, 20).map((r) => mapTvSearch(r, options));
      },
    },

    async healthCheck({ signal }) {
      try {
        await client.get('/configuration', {}, { signal, ttlMs: 60_000 });
        return { ok: true, message: 'Connected to TMDB' };
      } catch (err) {
        const status = (err as PluginHttpError).status;
        if (status === 401) return { ok: false, message: 'TMDB rejected the API key / token (401)' };
        return { ok: false, message: (err as Error).message };
      }
    },
  };
};

export default createPlugin;
