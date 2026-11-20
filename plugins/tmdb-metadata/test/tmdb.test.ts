import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { MetadataMatchRequest } from '@streamora/plugin-sdk';
import { callOptions, json, loadTestPlugin, mockFetch, type TestPlugin } from '../../../backend/test/helpers/harness.js';
import { normalizeTitle, pickBest, titleSimilarity } from '../match.js';

const PLUGIN_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const movieSearch = {
  page: 1,
  total_results: 3,
  results: [
    { id: 604, title: 'The Matrix Reloaded', release_date: '2003-05-15', popularity: 50 },
    { id: 603, title: 'The Matrix', original_title: 'The Matrix', release_date: '1999-03-30', popularity: 80 },
    { id: 9999, title: 'Matrix of Doom', release_date: '1999-01-01', popularity: 1 },
  ],
};

const movieDetails = {
  id: 603,
  title: 'The Matrix',
  original_title: 'The Matrix',
  tagline: 'Welcome to the Real World.',
  overview: 'Set in the 22nd century...',
  release_date: '1999-03-30',
  runtime: 136,
  status: 'Released',
  vote_average: 8.217,
  vote_count: 26000,
  genres: [{ id: 28, name: 'Action' }, { id: 878, name: 'Science Fiction' }],
  production_companies: [{ name: 'Village Roadshow Pictures' }, { name: 'Warner Bros. Pictures' }],
  poster_path: '/poster.jpg',
  backdrop_path: '/backdrop-with-text.jpg',
  imdb_id: 'tt0133093',
  images: {
    backdrops: [
      { file_path: '/bd-en.jpg', iso_639_1: 'en', vote_average: 9, vote_count: 10, width: 3840, height: 2160 },
      { file_path: '/bd-textless-low.jpg', iso_639_1: null, vote_average: 5, vote_count: 3, width: 1920, height: 1080 },
      { file_path: '/bd-textless-best.jpg', iso_639_1: null, vote_average: 5.5, vote_count: 8, width: 3840, height: 2160 },
    ],
    logos: [
      { file_path: '/logo-fr.png', iso_639_1: 'fr', vote_average: 9, vote_count: 3, width: 500, height: 200 },
      { file_path: '/logo-en.png', iso_639_1: 'en', vote_average: 5, vote_count: 3, width: 500, height: 200 },
    ],
  },
  credits: {
    cast: [
      { name: 'Carrie-Anne Moss', character: 'Trinity', order: 2, profile_path: '/cam.jpg' },
      { name: 'Keanu Reeves', character: 'Neo', order: 0, profile_path: '/kr.jpg' },
      { name: 'Laurence Fishburne', character: 'Morpheus', order: 1, profile_path: null },
    ],
    crew: [
      { name: 'Lana Wachowski', job: 'Director', department: 'Directing' },
      { name: 'Lana Wachowski', job: 'Director', department: 'Directing' },
      { name: 'Lilly Wachowski', job: 'Writer', department: 'Writing' },
      { name: 'Someone', job: 'Gaffer', department: 'Lighting' },
    ],
  },
  release_dates: {
    results: [
      { iso_3166_1: 'GB', release_dates: [{ certification: '15', type: 3 }] },
      { iso_3166_1: 'US', release_dates: [{ certification: '', type: 1 }, { certification: 'R', type: 3 }] },
    ],
  },
};

const tvSearch = { page: 1, total_results: 1, results: [{ id: 1396, name: 'Breaking Bad', first_air_date: '2008-01-20', popularity: 300 }] };
const tvDetails = {
  id: 1396,
  name: 'Breaking Bad',
  first_air_date: '2008-01-20',
  episode_run_time: [47],
  status: 'Ended',
  vote_average: 8.9,
  vote_count: 15000,
  genres: [{ name: 'Drama' }, { name: 'Crime' }],
  networks: [{ name: 'AMC' }],
  poster_path: '/bb-poster.jpg',
  backdrop_path: '/bb-backdrop.jpg',
  created_by: [{ name: 'Vince Gilligan', profile_path: '/vg.jpg' }],
  aggregate_credits: {
    cast: [
      { name: 'Aaron Paul', order: 1, roles: [{ character: 'Jesse Pinkman', episode_count: 62 }] },
      { name: 'Bryan Cranston', order: 0, roles: [{ character: 'Walter White', episode_count: 62 }] },
    ],
  },
  content_ratings: { results: [{ iso_3166_1: 'US', rating: 'TV-MA' }] },
  external_ids: { imdb_id: 'tt0903747', tvdb_id: 81189 },
};
const seasonDetails = {
  id: 3572,
  season_number: 1,
  name: 'Season 1',
  air_date: '2008-01-20',
  poster_path: '/s1.jpg',
  episodes: [
    { id: 62085, season_number: 1, episode_number: 1, name: 'Pilot', overview: 'Walter...', air_date: '2008-01-20', runtime: 58, vote_average: 8.3, vote_count: 200, still_path: '/e1.jpg' },
    { id: 62086, season_number: 1, episode_number: 2, name: "Cat's in the Bag...", runtime: null, vote_count: 0 },
  ],
};

const movieRequest = (overrides: Partial<MetadataMatchRequest> = {}): MetadataMatchRequest => ({
  kind: 'movie',
  title: 'The Matrix',
  year: 1999,
  language: 'en-US',
  libraryType: 'movies',
  externalIds: {},
  filePaths: [],
  current: { kind: 'movie' },
  ...overrides,
});

let plugin: TestPlugin | undefined;
afterEach(() => {
  plugin?.close();
  plugin = undefined;
});

type Routes = Record<string, (url: URL) => Response>;

const defaultRoutes: Routes = {
  '/3/search/movie': () => json(movieSearch),
  '/3/movie/603': () => json(movieDetails),
  '/3/find/tt0133093': () => json({ movie_results: [{ id: 603, title: 'The Matrix' }], tv_results: [] }),
  '/3/search/tv': () => json(tvSearch),
  '/3/tv/1396': () => json(tvDetails),
  '/3/tv/1396/season/1': () => json(seasonDetails),
  '/3/configuration': () => json({ images: {} }),
};

async function load(settings: Record<string, string | number | boolean> = {}, routes: Routes = defaultRoutes) {
  const mock = mockFetch(routes);
  plugin = await loadTestPlugin(PLUGIN_DIR, { settings: { apiKey: 'v3-test-key', ...settings }, fetchImpl: mock.fetchImpl });
  return { plugin, metadata: plugin.instance.metadata!, calls: mock.calls };
}

describe('tmdb-metadata: matching', () => {
  it('finds a movie by title + year and maps the details', async () => {
    const { metadata, calls } = await load();
    const result = await metadata.match(movieRequest(), callOptions());

    expect(result).toMatchObject({
      kind: 'movie',
      title: 'The Matrix',
      year: 1999,
      releaseDate: '1999-03-30',
      tagline: 'Welcome to the Real World.',
      runtimeMinutes: 136,
      rating: 8.2,
      contentRating: 'R',
      genres: ['Action', 'Science Fiction'],
      studios: ['Village Roadshow Pictures', 'Warner Bros. Pictures'],
      externalIds: { tmdb: '603', imdb: 'tt0133093' },
      artwork: {
        poster: 'https://image.tmdb.org/t/p/w500/poster.jpg',
        backdrop: 'https://image.tmdb.org/t/p/w1280/bd-textless-best.jpg',
        logo: 'https://image.tmdb.org/t/p/w500/logo-en.png',
      },
    });
    expect(result!.originalTitle).toBeUndefined();
    expect(result!.confidence).toBeGreaterThan(0.9);
    expect(result!.cast!.map((c) => c.name)).toEqual(['Keanu Reeves', 'Laurence Fishburne', 'Carrie-Anne Moss']);
    expect(result!.cast![0]).toEqual({ name: 'Keanu Reeves', character: 'Neo', order: 0, photo: 'https://image.tmdb.org/t/p/w185/kr.jpg' });
    expect(result!.crew!.map((c) => `${c.name}:${c.job}`)).toEqual(['Lana Wachowski:Director', 'Lilly Wachowski:Writer']);

    const search = calls.find((c) => c.url.pathname === '/3/search/movie')!;
    expect(search.url.searchParams.get('query')).toBe('The Matrix');
    expect(search.url.searchParams.get('year')).toBe('1999');
    expect(search.url.searchParams.get('api_key')).toBe('v3-test-key');
    const details = calls.find((c) => c.url.pathname === '/3/movie/603')!;
    expect(details.url.searchParams.get('append_to_response')).toBe('credits,images,release_dates,external_ids');
    expect(details.url.searchParams.get('include_image_language')).toBe('en,null');
  });

  it('uses the configured certification country and image sizes', async () => {
    const { metadata } = await load({ region: 'GB', posterSize: 'original' });
    const result = await metadata.match(movieRequest(), callOptions());
    expect(result?.contentRating).toBe('15');
    expect(result?.artwork?.poster).toBe('https://image.tmdb.org/t/p/original/poster.jpg');
  });

  it('skips searching when an IMDb or TMDB id is already known', async () => {
    const byImdb = await load();
    await byImdb.metadata.match(movieRequest({ title: 'Wrong Name', externalIds: { imdb: 'tt0133093' } }), callOptions());
    expect(byImdb.calls.map((c) => c.url.pathname)).toEqual(['/3/find/tt0133093', '/3/movie/603']);
    plugin!.close();

    const byTmdb = await load();
    await byTmdb.metadata.match(movieRequest({ externalIds: { tmdb: '603' } }), callOptions());
    expect(byTmdb.calls.map((c) => c.url.pathname)).toEqual(['/3/movie/603']);
  });

  it('sends v4 read access tokens as a bearer header', async () => {
    const token = 'eyJhbGciOiJIUzI1NiJ9.eyJhdWQiOiJ0ZXN0In0.c2lnbmF0dXJlLXNpZ25hdHVyZS1zaWduYXR1cmU';
    const { metadata, calls } = await load({ apiKey: token });
    await metadata.match(movieRequest({ externalIds: { tmdb: '603' } }), callOptions());
    const headers = calls[0]!.init?.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${token}`);
    expect(calls[0]!.url.searchParams.has('api_key')).toBe(false);
  });

  it('rejects low-confidence search results', async () => {
    const { metadata } = await load({}, {
      ...defaultRoutes,
      '/3/search/movie': () => json({ page: 1, total_results: 1, results: [{ id: 1, title: 'Completely Different', release_date: '2010-01-01' }] }),
    });
    expect(await metadata.match(movieRequest(), callOptions())).toBeNull();
  });

  it('retries without the year when the year filter finds nothing', async () => {
    const { metadata, calls } = await load({}, {
      ...defaultRoutes,
      '/3/search/movie': (url: URL) => json(url.searchParams.has('year') ? { page: 1, total_results: 0, results: [] } : movieSearch),
    });
    const result = await metadata.match(movieRequest({ year: 1998 }), callOptions());
    expect(result?.externalIds?.tmdb).toBe('603');
    expect(calls.filter((c) => c.url.pathname === '/3/search/movie')).toHaveLength(2);
  });

  it('caches API responses', async () => {
    const { metadata, calls } = await load();
    await metadata.match(movieRequest(), callOptions());
    const first = calls.length;
    await metadata.match(movieRequest(), callOptions());
    expect(calls.length).toBe(first);
  });

  it('returns null for stale ids instead of failing', async () => {
    const { metadata } = await load({}, { ...defaultRoutes, '/3/movie/603': () => json({ status_message: 'not found' }, 404) });
    expect(await metadata.match(movieRequest({ externalIds: { tmdb: '603' } }), callOptions())).toBeNull();
  });

  it('maps shows and seasons', async () => {
    const { metadata } = await load();
    const show = await metadata.match(
      movieRequest({ kind: 'show', title: 'Breaking Bad', year: undefined, libraryType: 'shows' }),
      callOptions(),
    );
    expect(show).toMatchObject({
      kind: 'show',
      title: 'Breaking Bad',
      year: 2008,
      runtimeMinutes: 47,
      status: 'Ended',
      contentRating: 'TV-MA',
      studios: ['AMC'],
      externalIds: { tmdb: '1396', imdb: 'tt0903747', tvdb: '81189' },
      artwork: { backdrop: 'https://image.tmdb.org/t/p/w1280/bb-backdrop.jpg' },
    });
    expect(show!.cast!.map((c) => c.character)).toEqual(['Walter White', 'Jesse Pinkman']);
    expect(show!.crew![0]).toMatchObject({ name: 'Vince Gilligan', job: 'Creator' });

    const season = await metadata.getSeason!(
      {
        show: { title: 'Breaking Bad', externalIds: { tmdb: '1396' } },
        seasonNumber: 1,
        language: 'en-US',
        episodes: [],
      },
      callOptions(),
    );
    expect(season).toMatchObject({ seasonNumber: 1, title: 'Season 1', poster: 'https://image.tmdb.org/t/p/w500/s1.jpg' });
    expect(season!.episodes).toEqual([
      {
        seasonNumber: 1,
        episodeNumber: 1,
        title: 'Pilot',
        overview: 'Walter...',
        airDate: '2008-01-20',
        runtimeMinutes: 58,
        rating: 8.3,
        still: 'https://image.tmdb.org/t/p/w300/e1.jpg',
        externalIds: { tmdb: '62085' },
      },
      { seasonNumber: 1, episodeNumber: 2, title: "Cat's in the Bag...", externalIds: { tmdb: '62086' } },
    ]);
  });

  it('powers the manual search and health check', async () => {
    const { metadata, plugin: p } = await load();
    const results = await metadata.search!({ kind: 'movie', query: 'Matrix', language: 'en-US' }, callOptions());
    expect(results[1]).toEqual({ kind: 'movie', title: 'The Matrix', year: 1999, externalIds: { tmdb: '603' } });
    expect(await p.instance.healthCheck!(callOptions())).toEqual({ ok: true, message: 'Connected to TMDB' });
  });

  it('reports a rejected key in the health check', async () => {
    const { plugin: p } = await load({}, { ...defaultRoutes, '/3/configuration': () => json({ status_code: 7 }, 401) });
    expect(await p.instance.healthCheck!(callOptions())).toMatchObject({ ok: false, message: expect.stringMatching(/401/) });
  });
});

describe('tmdb-metadata: title scoring', () => {
  it('normalises titles', () => {
    expect(normalizeTitle('The Lord of the Rings: The Return of the King')).toBe('lord of the rings the return of the king');
    expect(normalizeTitle('Amélie')).toBe('amelie');
    expect(normalizeTitle("Ocean's Eleven")).toBe('oceans eleven');
    expect(normalizeTitle('Fast & Furious')).toBe('fast and furious');
  });

  it('scores similarity', () => {
    expect(titleSimilarity('Amélie', 'Amelie')).toBe(1);
    expect(titleSimilarity('The Matrix', 'Matrix')).toBe(1);
    expect(titleSimilarity('The Matrix', 'The Matrix Reloaded')).toBeLessThan(0.8);
  });

  it('prefers the right year among remakes', () => {
    const best = pickBest(
      [
        { id: 1, title: 'Dune', year: 1984 },
        { id: 2, title: 'Dune', year: 2021 },
      ],
      { title: 'Dune', year: 2021 },
    );
    expect(best?.candidate.id).toBe(2);
  });
});
