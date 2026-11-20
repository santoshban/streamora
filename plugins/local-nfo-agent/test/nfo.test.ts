import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MetadataMatchRequest } from '@streamora/plugin-sdk';
import { callOptions, loadTestPlugin, tempDir, writeFiles, type TestPlugin } from '../../../backend/test/helpers/harness.js';
import { normalizeCertification, parseNfo } from '../nfo-parser.js';

const PLUGIN_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const MOVIE_NFO = `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>
<movie>
  <title>The Matrix</title>
  <originaltitle>The Matrix</originaltitle>
  <sorttitle>Matrix 1</sorttitle>
  <ratings>
    <rating name="imdb" max="10" default="true"><value>8.7</value><votes>2000000</votes></rating>
    <rating name="metacritic" max="100"><value>73</value></rating>
  </ratings>
  <plot>A computer hacker learns about the true nature of reality &amp; his role in the war.</plot>
  <tagline>Welcome to the Real World.</tagline>
  <runtime>136</runtime>
  <mpaa>US:Rated R</mpaa>
  <thumb aspect="poster">https://example.com/poster.jpg</thumb>
  <thumb aspect="clearlogo">https://example.com/logo.png</thumb>
  <fanart><thumb>https://example.com/fanart.jpg</thumb></fanart>
  <uniqueid type="imdb" default="true">tt0133093</uniqueid>
  <uniqueid type="tmdb">603</uniqueid>
  <genre>Action / Science Fiction</genre>
  <genre>Action</genre>
  <studio>Warner Bros.</studio>
  <director>Lana Wachowski</director>
  <director>Lilly Wachowski</director>
  <credits>Lana Wachowski</credits>
  <premiered>1999-03-30</premiered>
  <actor><name>Keanu Reeves</name><role>Neo</role><order>0</order><thumb>https://example.com/keanu.jpg</thumb></actor>
  <actor><name>Laurence Fishburne</name><role>Morpheus</role><order>1</order></actor>
</movie>
https://www.themoviedb.org/movie/603-the-matrix`;

const SHOW_NFO = `<tvshow>
  <title>Breaking Bad</title>
  <plot>A chemistry teacher turned meth cook.</plot>
  <year>2008</year>
  <status>Ended</status>
  <id>81189</id>
  <rating>9.5</rating>
  <genre>Drama</genre>
</tvshow>`;

const MULTI_EPISODE_NFO = `<episodedetails><title>Part One</title><season>1</season><episode>1</episode><aired>2008-01-20</aired></episodedetails>
<episodedetails><title>Part Two</title><season>1</season><episode>2</episode><plot>Second half.</plot></episodedetails>`;

describe('parseNfo', () => {
  it('parses a Kodi movie NFO', () => {
    const [nfo] = parseNfo(MOVIE_NFO);
    expect(nfo).toMatchObject({
      kind: 'movie',
      title: 'The Matrix',
      sortTitle: 'Matrix 1',
      year: 1999,
      releaseDate: '1999-03-30',
      overview: 'A computer hacker learns about the true nature of reality & his role in the war.',
      runtimeMinutes: 136,
      contentRating: 'R',
      rating: 8.7,
      genres: ['Action', 'Science Fiction'],
      studios: ['Warner Bros.'],
      directors: ['Lana Wachowski', 'Lilly Wachowski'],
      writers: ['Lana Wachowski'],
      externalIds: { imdb: 'tt0133093', tmdb: '603' },
      posterUrls: ['https://example.com/poster.jpg'],
      fanartUrls: ['https://example.com/fanart.jpg'],
    });
    expect(nfo!.actors).toEqual([
      { name: 'Keanu Reeves', character: 'Neo', order: 0, photo: 'https://example.com/keanu.jpg' },
      { name: 'Laurence Fishburne', character: 'Morpheus', order: 1 },
    ]);
  });

  it('reads legacy show ids, multi-episode files and URL-only NFOs', () => {
    expect(parseNfo(SHOW_NFO)[0]).toMatchObject({ kind: 'tvshow', year: 2008, rating: 9.5, externalIds: { tvdb: '81189' } });
    expect(parseNfo(MULTI_EPISODE_NFO).map((e) => [e.season, e.episode, e.title])).toEqual([
      [1, 1, 'Part One'],
      [1, 2, 'Part Two'],
    ]);
    expect(parseNfo('https://www.imdb.com/title/tt0133093/')).toMatchObject([{ kind: 'url-only', externalIds: { imdb: 'tt0133093' } }]);
    expect(parseNfo('<movie><title>Broken')).toEqual([]);
  });

  it('normalises certifications', () => {
    expect(normalizeCertification('Rated PG-13')).toBe('PG-13');
    expect(normalizeCertification('US:PG-13 / US:Rated PG-13')).toBe('PG-13');
    expect(normalizeCertification('DE:FSK 16')).toBe('FSK 16');
  });
});

describe('local-nfo-agent plugin', () => {
  let root: string;
  let plugin: TestPlugin;
  const p = (...parts: string[]) => path.join(root, ...parts);

  beforeAll(async () => {
    root = tempDir('streamora-nfo-');
    writeFiles(root, {
      'Movies/The Matrix (1999)/The Matrix (1999).mkv': '',
      'Movies/The Matrix (1999)/The Matrix (1999).nfo': MOVIE_NFO,
      'Movies/The Matrix (1999)/Poster.JPG': 'img',
      'Movies/The Matrix (1999)/fanart.jpg': 'img',
      'Movies/The Matrix (1999)/clearlogo.png': 'img',
      'Movies/The Matrix (1999)/The Matrix (1999)-sample.mkv': '',
      // Two movies sharing one folder: folder-level art must not be attributed to either.
      'Movies/Shared/Alien (1979).mkv': '',
      'Movies/Shared/Alien (1979)-poster.jpg': 'img',
      'Movies/Shared/Aliens (1986).mkv': '',
      'Movies/Shared/poster.jpg': 'img',
      'Shows/Breaking Bad/tvshow.nfo': SHOW_NFO,
      'Shows/Breaking Bad/poster.jpg': 'img',
      'Shows/Breaking Bad/season01-poster.jpg': 'img',
      'Shows/Breaking Bad/Season 1/Breaking Bad - S01E01-E02.mkv': '',
      'Shows/Breaking Bad/Season 1/Breaking Bad - S01E01-E02.nfo': MULTI_EPISODE_NFO,
      'Shows/Breaking Bad/Season 1/Breaking Bad - S01E01-E02-thumb.jpg': 'img',
      'Shows/Breaking Bad/Season 1/Breaking Bad - S01E03.mkv': '',
      'Elsewhere/secret.nfo': '<movie><title>Secret</title></movie>',
    });
    plugin = await loadTestPlugin(PLUGIN_DIR, { libraryRoots: [p('Movies'), p('Shows')] });
  });

  afterAll(() => {
    plugin.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const request = (overrides: Partial<MetadataMatchRequest>): MetadataMatchRequest => ({
    kind: 'movie',
    title: 'x',
    language: 'en-US',
    libraryType: 'movies',
    externalIds: {},
    filePaths: [],
    current: { kind: 'movie' },
    ...overrides,
  });

  it('combines the movie NFO with local artwork (local files beat NFO URLs)', async () => {
    const file = p('Movies', 'The Matrix (1999)', 'The Matrix (1999).mkv');
    const result = await plugin.instance.metadata!.match(request({ filePaths: [file] }), callOptions());
    expect(result).toMatchObject({
      title: 'The Matrix',
      year: 1999,
      contentRating: 'R',
      externalIds: { imdb: 'tt0133093', tmdb: '603' },
      crew: [
        { name: 'Lana Wachowski', job: 'Director' },
        { name: 'Lilly Wachowski', job: 'Director' },
        { name: 'Lana Wachowski', job: 'Writer' },
      ],
      artwork: {
        poster: p('Movies', 'The Matrix (1999)', 'Poster.JPG'),
        backdrop: p('Movies', 'The Matrix (1999)', 'fanart.jpg'),
        logo: p('Movies', 'The Matrix (1999)', 'clearlogo.png'),
      },
    });
  });

  it('does not attribute folder art in shared folders', async () => {
    const alien = await plugin.instance.metadata!.match(request({ filePaths: [p('Movies', 'Shared', 'Alien (1979).mkv')] }), callOptions());
    expect(alien?.artwork).toEqual({ poster: p('Movies', 'Shared', 'Alien (1979)-poster.jpg') });
    const aliens = await plugin.instance.metadata!.match(request({ filePaths: [p('Movies', 'Shared', 'Aliens (1986).mkv')] }), callOptions());
    expect(aliens).toBeNull();
  });

  it('reads tvshow.nfo, season posters, episode NFOs and thumbs', async () => {
    const show = await plugin.instance.metadata!.match(
      request({ kind: 'show', libraryType: 'shows', folderPath: p('Shows', 'Breaking Bad') }),
      callOptions(),
    );
    expect(show).toMatchObject({
      title: 'Breaking Bad',
      status: 'Ended',
      externalIds: { tvdb: '81189' },
      artwork: { poster: p('Shows', 'Breaking Bad', 'poster.jpg') },
    });

    const episodeFile = p('Shows', 'Breaking Bad', 'Season 1', 'Breaking Bad - S01E01-E02.mkv');
    const season = await plugin.instance.metadata!.getSeason!(
      {
        show: { title: 'Breaking Bad', externalIds: {}, folderPath: p('Shows', 'Breaking Bad') },
        seasonNumber: 1,
        language: 'en-US',
        episodes: [
          { seasonNumber: 1, episodeNumber: 1, filePaths: [episodeFile] },
          { seasonNumber: 1, episodeNumber: 2, filePaths: [episodeFile] },
          { seasonNumber: 1, episodeNumber: 3, filePaths: [p('Shows', 'Breaking Bad', 'Season 1', 'Breaking Bad - S01E03.mkv')] },
        ],
      },
      callOptions(),
    );
    const thumb = p('Shows', 'Breaking Bad', 'Season 1', 'Breaking Bad - S01E01-E02-thumb.jpg');
    expect(season).toMatchObject({
      seasonNumber: 1,
      poster: p('Shows', 'Breaking Bad', 'season01-poster.jpg'),
      episodes: [
        { seasonNumber: 1, episodeNumber: 1, title: 'Part One', airDate: '2008-01-20', still: thumb },
        { seasonNumber: 1, episodeNumber: 2, title: 'Part Two', overview: 'Second half.', still: thumb },
      ],
    });
  });

  it('cannot read outside the configured library folders', async () => {
    await expect(plugin.ctx.fs.readText(p('Elsewhere', 'secret.nfo'))).rejects.toThrow(/outside every configured library folder/);
  });

  it('can withhold ids from other agents', async () => {
    const strict = await loadTestPlugin(PLUGIN_DIR, { libraryRoots: [p('Movies')], settings: { passIds: false } });
    try {
      const file = p('Movies', 'The Matrix (1999)', 'The Matrix (1999).mkv');
      const result = await strict.instance.metadata!.match(request({ filePaths: [file] }), callOptions());
      expect(result?.externalIds).toEqual({});
      expect(result?.title).toBe('The Matrix');
    } finally {
      strict.close();
    }
  });
});
