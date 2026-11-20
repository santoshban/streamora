import type {
  CastMember,
  CrewMember,
  EpisodeMetadata,
  MetadataMatchResult,
  MetadataSearchResult,
  SeasonMetadata,
} from '@streamora/plugin-sdk';
import { parseYear } from './match.js';
import type {
  TmdbImage,
  TmdbMovieDetails,
  TmdbMovieSummary,
  TmdbSeasonDetails,
  TmdbTvDetails,
  TmdbTvSummary,
} from './types.js';

export interface ImageOptions {
  imageBaseUrl: string;
  posterSize: string;
  backdropSize: string;
  /** Two-letter language used to pick localised logos (`en`). */
  language: string;
  region: string;
  castLimit: number;
}

const CREW_JOBS = new Set(['Director', 'Screenplay', 'Writer', 'Novel', 'Story', 'Creator', 'Original Music Composer']);

const img = (o: ImageOptions, size: string, filePath?: string | null) =>
  filePath ? `${o.imageBaseUrl.replace(/\/$/, '')}/${size}${filePath}` : undefined;

const rating = (average?: number, count?: number) =>
  average !== undefined && (count ?? 0) > 0 ? Math.round(average * 10) / 10 : undefined;

const nonEmpty = (s?: string | null) => (s && s.trim() !== '' ? s.trim() : undefined);

function byQuality(a: TmdbImage, b: TmdbImage): number {
  return b.vote_average - a.vote_average || b.vote_count - a.vote_count || b.width - a.width;
}

/** Textless backdrops look best behind the overlaid title logo. */
export function pickBackdrop(images: TmdbImage[] | undefined, fallback?: string | null): string | null | undefined {
  const textless = (images ?? []).filter((i) => i.iso_639_1 === null).sort(byQuality);
  return textless[0]?.file_path ?? fallback;
}

/** Logo in the requested language, then English, then anything. */
export function pickLogo(images: TmdbImage[] | undefined, language: string): string | undefined {
  const logos = [...(images ?? [])].sort(byQuality);
  return (
    logos.find((l) => l.iso_639_1 === language)?.file_path ??
    logos.find((l) => l.iso_639_1 === 'en')?.file_path ??
    logos[0]?.file_path
  );
}

function movieCertification(details: TmdbMovieDetails, region: string): string | undefined {
  const results = details.release_dates?.results ?? [];
  for (const country of [region, 'US']) {
    const entry = results.find((r) => r.iso_3166_1 === country);
    // Prefer theatrical (3), then limited (2), digital (4), physical (5), TV (6), premiere (1).
    const order = [3, 2, 4, 5, 6, 1];
    const cert = [...(entry?.release_dates ?? [])]
      .filter((d) => nonEmpty(d.certification))
      .sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type))[0]?.certification;
    if (cert) return cert.trim();
  }
  return undefined;
}

function tvCertification(details: TmdbTvDetails, region: string): string | undefined {
  const results = details.content_ratings?.results ?? [];
  for (const country of [region, 'US']) {
    const cert = nonEmpty(results.find((r) => r.iso_3166_1 === country)?.rating);
    if (cert) return cert;
  }
  return undefined;
}

function dedupeCrew(crew: CrewMember[]): CrewMember[] {
  const seen = new Set<string>();
  return crew.filter((c) => {
    const key = `${c.name}|${c.job}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function mapMovie(d: TmdbMovieDetails, o: ImageOptions, confidence: number): MetadataMatchResult {
  const cast: CastMember[] = [...(d.credits?.cast ?? [])]
    .sort((a, b) => (a.order ?? 999) - (b.order ?? 999))
    .slice(0, o.castLimit)
    .map((c) => ({ name: c.name, character: nonEmpty(c.character), order: c.order, photo: img(o, 'w185', c.profile_path) }));

  const crew = dedupeCrew(
    (d.credits?.crew ?? [])
      .filter((c) => CREW_JOBS.has(c.job))
      .map((c) => ({ name: c.name, job: c.job, department: c.department, photo: img(o, 'w185', c.profile_path) })),
  ).slice(0, 20);

  const imdb = nonEmpty(d.imdb_id) ?? nonEmpty(d.external_ids?.imdb_id);

  return {
    kind: 'movie',
    confidence,
    title: d.title,
    originalTitle: d.original_title && d.original_title !== d.title ? d.original_title : undefined,
    year: parseYear(d.release_date),
    releaseDate: nonEmpty(d.release_date),
    tagline: nonEmpty(d.tagline),
    overview: nonEmpty(d.overview),
    genres: d.genres?.map((g) => g.name),
    studios: d.production_companies?.slice(0, 5).map((c) => c.name),
    contentRating: movieCertification(d, o.region),
    rating: rating(d.vote_average, d.vote_count),
    runtimeMinutes: d.runtime || undefined,
    status: nonEmpty(d.status),
    cast,
    crew,
    artwork: {
      poster: img(o, o.posterSize, d.poster_path),
      backdrop: img(o, o.backdropSize, pickBackdrop(d.images?.backdrops, d.backdrop_path)),
      logo: img(o, 'w500', pickLogo(d.images?.logos, o.language)),
    },
    externalIds: { tmdb: String(d.id), ...(imdb ? { imdb } : {}) },
  };
}

export function mapShow(d: TmdbTvDetails, o: ImageOptions, confidence: number): MetadataMatchResult {
  const cast: CastMember[] = [...(d.aggregate_credits?.cast ?? [])]
    .sort((a, b) => (a.order ?? 999) - (b.order ?? 999))
    .slice(0, o.castLimit)
    .map((c) => ({
      name: c.name,
      character: nonEmpty(c.roles?.[0]?.character),
      order: c.order,
      photo: img(o, 'w185', c.profile_path),
    }));

  const crew = dedupeCrew([
    ...(d.created_by ?? []).map((c) => ({ name: c.name, job: 'Creator', photo: img(o, 'w185', c.profile_path) })),
    ...(d.aggregate_credits?.crew ?? []).flatMap((c) =>
      (c.jobs ?? [])
        .filter((j) => CREW_JOBS.has(j.job))
        .map((j) => ({ name: c.name, job: j.job, department: c.department, photo: img(o, 'w185', c.profile_path) })),
    ),
  ]).slice(0, 20);

  const imdb = nonEmpty(d.external_ids?.imdb_id);
  const tvdb = d.external_ids?.tvdb_id ? String(d.external_ids.tvdb_id) : undefined;

  return {
    kind: 'show',
    confidence,
    title: d.name,
    originalTitle: d.original_name && d.original_name !== d.name ? d.original_name : undefined,
    year: parseYear(d.first_air_date),
    releaseDate: nonEmpty(d.first_air_date),
    tagline: nonEmpty(d.tagline),
    overview: nonEmpty(d.overview),
    genres: d.genres?.map((g) => g.name),
    studios: d.networks?.slice(0, 5).map((n) => n.name),
    contentRating: tvCertification(d, o.region),
    rating: rating(d.vote_average, d.vote_count),
    runtimeMinutes: d.episode_run_time?.[0] || undefined,
    status: nonEmpty(d.status),
    cast,
    crew,
    artwork: {
      poster: img(o, o.posterSize, d.poster_path),
      backdrop: img(o, o.backdropSize, pickBackdrop(d.images?.backdrops, d.backdrop_path)),
      logo: img(o, 'w500', pickLogo(d.images?.logos, o.language)),
    },
    externalIds: { tmdb: String(d.id), ...(imdb ? { imdb } : {}), ...(tvdb ? { tvdb } : {}) },
  };
}

export function mapSeason(s: TmdbSeasonDetails, o: ImageOptions): SeasonMetadata {
  const episodes: EpisodeMetadata[] = (s.episodes ?? []).map((e) => ({
    seasonNumber: e.season_number,
    episodeNumber: e.episode_number,
    title: nonEmpty(e.name),
    overview: nonEmpty(e.overview),
    airDate: nonEmpty(e.air_date),
    runtimeMinutes: e.runtime || undefined,
    rating: rating(e.vote_average, e.vote_count),
    still: img(o, 'w300', e.still_path),
    externalIds: { tmdb: String(e.id) },
  }));
  return {
    seasonNumber: s.season_number,
    title: nonEmpty(s.name),
    overview: nonEmpty(s.overview),
    airDate: nonEmpty(s.air_date),
    poster: img(o, o.posterSize, s.poster_path),
    externalIds: { tmdb: String(s.id) },
    episodes,
  };
}

export function mapMovieSearch(r: TmdbMovieSummary, o: ImageOptions): MetadataSearchResult {
  return {
    kind: 'movie',
    title: r.title,
    year: parseYear(r.release_date),
    overview: nonEmpty(r.overview),
    poster: img(o, 'w342', r.poster_path),
    externalIds: { tmdb: String(r.id) },
  };
}

export function mapTvSearch(r: TmdbTvSummary, o: ImageOptions): MetadataSearchResult {
  return {
    kind: 'show',
    title: r.name,
    year: parseYear(r.first_air_date),
    overview: nonEmpty(r.overview),
    poster: img(o, 'w342', r.poster_path),
    externalIds: { tmdb: String(r.id) },
  };
}
