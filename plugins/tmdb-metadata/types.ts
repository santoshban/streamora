/** Subset of TMDB v3 response shapes used by this plugin. */

export interface TmdbPaged<T> {
  page: number;
  results: T[];
  total_results: number;
}

export interface TmdbMovieSummary {
  id: number;
  title: string;
  original_title?: string;
  release_date?: string;
  overview?: string;
  poster_path?: string | null;
  popularity?: number;
}

export interface TmdbTvSummary {
  id: number;
  name: string;
  original_name?: string;
  first_air_date?: string;
  overview?: string;
  poster_path?: string | null;
  popularity?: number;
}

export interface TmdbFindResult {
  movie_results: TmdbMovieSummary[];
  tv_results: TmdbTvSummary[];
}

export interface TmdbImage {
  file_path: string;
  iso_639_1: string | null;
  vote_average: number;
  vote_count: number;
  width: number;
  height: number;
}

export interface TmdbImages {
  posters?: TmdbImage[];
  backdrops?: TmdbImage[];
  logos?: TmdbImage[];
}

export interface TmdbCastCredit {
  name: string;
  character?: string;
  order?: number;
  profile_path?: string | null;
}

export interface TmdbCrewCredit {
  name: string;
  job: string;
  department?: string;
  profile_path?: string | null;
}

export interface TmdbCredits {
  cast?: TmdbCastCredit[];
  crew?: TmdbCrewCredit[];
}

export interface TmdbAggregateCredits {
  cast?: Array<{
    name: string;
    order?: number;
    profile_path?: string | null;
    total_episode_count?: number;
    roles?: Array<{ character: string; episode_count: number }>;
  }>;
  crew?: Array<{
    name: string;
    department?: string;
    profile_path?: string | null;
    jobs?: Array<{ job: string; episode_count: number }>;
  }>;
}

interface TmdbNamed {
  id?: number;
  name: string;
}

export interface TmdbMovieDetails {
  id: number;
  title: string;
  original_title?: string;
  original_language?: string;
  tagline?: string;
  overview?: string;
  release_date?: string;
  runtime?: number | null;
  status?: string;
  vote_average?: number;
  vote_count?: number;
  genres?: TmdbNamed[];
  production_companies?: TmdbNamed[];
  poster_path?: string | null;
  backdrop_path?: string | null;
  imdb_id?: string | null;
  images?: TmdbImages;
  credits?: TmdbCredits;
  release_dates?: {
    results: Array<{
      iso_3166_1: string;
      release_dates: Array<{ certification: string; type: number }>;
    }>;
  };
  external_ids?: { imdb_id?: string | null };
}

export interface TmdbTvDetails {
  id: number;
  name: string;
  original_name?: string;
  original_language?: string;
  tagline?: string;
  overview?: string;
  first_air_date?: string;
  episode_run_time?: number[];
  status?: string;
  vote_average?: number;
  vote_count?: number;
  genres?: TmdbNamed[];
  networks?: TmdbNamed[];
  poster_path?: string | null;
  backdrop_path?: string | null;
  created_by?: Array<{ name: string; profile_path?: string | null }>;
  images?: TmdbImages;
  aggregate_credits?: TmdbAggregateCredits;
  content_ratings?: { results: Array<{ iso_3166_1: string; rating: string }> };
  external_ids?: { imdb_id?: string | null; tvdb_id?: number | null };
}

export interface TmdbEpisode {
  id: number;
  season_number: number;
  episode_number: number;
  name?: string;
  overview?: string;
  air_date?: string | null;
  runtime?: number | null;
  vote_average?: number;
  vote_count?: number;
  still_path?: string | null;
}

export interface TmdbSeasonDetails {
  id: number;
  season_number: number;
  name?: string;
  overview?: string;
  air_date?: string | null;
  poster_path?: string | null;
  episodes?: TmdbEpisode[];
}

/** `/movie/{id}/videos`, `/tv/{id}/videos` */
export interface TmdbVideo {
  id: string;
  key: string;
  site: string;
  /** Trailer, Teaser, Clip, Featurette, Behind the Scenes, Bloopers, Opening Credits */
  type: string;
  name?: string;
  size?: number;
  official?: boolean;
  published_at?: string;
  iso_639_1?: string | null;
}

export interface TmdbVideos {
  results: TmdbVideo[];
}
