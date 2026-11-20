import { describe, expect, it } from 'vitest';
import { isExtraFile, isSkippedDir } from '../src/media/extensions.js';
import {
  cleanTitle,
  matchKeyOf,
  parseBareEpisode,
  parseName,
  parseSeasonFolder,
  sortTitleOf,
} from '../src/media/parse.js';

describe('parseName — movies', () => {
  it.each([
    ['The Matrix (1999).mkv', { title: 'The Matrix', year: 1999 }],
    ['The.Matrix.1999.1080p.BluRay.x264-GROUP.mkv', { title: 'The Matrix', year: 1999, resolution: '1080p', source: 'BluRay', releaseGroup: 'GROUP' }],
    ['Blade Runner 2049 (2017).mkv', { title: 'Blade Runner 2049', year: 2017 }],
    ['Blade.Runner.2049.2017.2160p.UHD.BluRay.REMUX.HDR.HEVC-FGT.mkv', { title: 'Blade Runner 2049', year: 2017, resolution: '4K', source: 'Remux', releaseGroup: 'FGT' }],
    ['2001 A Space Odyssey (1968).mkv', { title: '2001 A Space Odyssey', year: 1968 }],
    ['1917.2019.1080p.WEB-DL.mkv', { title: '1917', year: 2019, resolution: '1080p', source: 'WEB' }],
    ['2012.mkv', { title: '2012' }],
    ['Blade.Runner.2049.mkv', { title: 'Blade Runner 2049' }],
    ['Avengers Endgame [2019] 2160p.mkv', { title: 'Avengers Endgame', year: 2019, resolution: '4K' }],
    ['Inception (2010) {tmdb-27205}.mkv', { title: 'Inception', year: 2010, externalIds: { tmdb: '27205' } }],
    ['Inception (2010) [imdbid-tt1375666] - 1080p.mkv', { title: 'Inception', year: 2010, resolution: '1080p', externalIds: { imdb: 'tt1375666' } }],
    ['Blade Runner (1982) {edition-Final Cut}.mkv', { title: 'Blade Runner', year: 1982, edition: 'Final Cut' }],
    ['Aliens.1986.Directors.Cut.1080p.BluRay.mkv', { title: 'Aliens', year: 1986, edition: "Director's Cut", resolution: '1080p', source: 'BluRay' }],
    ['Amélie (2001).mkv', { title: 'Amélie', year: 2001 }],
    ['Mr. Robot Movie (2020).mp4', { title: 'Mr. Robot Movie', year: 2020 }],
    ['S.W.A.T.2003.720p.mkv', { title: 'S.W.A.T.', year: 2003, resolution: '720p' }],
    ['movie_title_2004.avi', { title: 'movie title', year: 2004 }],
    ['Spider-Man.No.Way.Home.2021.mkv', { title: 'Spider-Man No Way Home', year: 2021 }],
    // Download-style names (titles, sites and groups are made up)
    ['(SomeSite.CA) The Quiet Harbour (2024) (Hindi DD5.1-384Kbps + Telugu DD5.1-192Kbps) Dual Audio UnCut South Movie HEVC 2160p ESub.mkv',
      { title: 'The Quiet Harbour', year: 2024, resolution: '4K', edition: 'Unrated' }],
    ['www.SomeSite.org    -    Northern Lights 2025 1080p AnyVideo WEB-DL H 264 DD5 1-NOGRP', { title: 'Northern Lights', year: 2025, resolution: '1080p', source: 'WEB', releaseGroup: 'NOGRP' }],
    ['[SomeSite.MX] Heat (1995) [1080p].mp4', { title: 'Heat', year: 1995, resolution: '1080p' }],
    ['Paper.Lanterns.2023.2160p.4K.WEB.x265.10bit.AAC5.1-[SiteA.GG - SiteB.BZ].mkv', { title: 'Paper Lanterns', year: 2023, resolution: '4K', source: 'WEB' }],
    ['Silent Signals S01 (Ep.01-07) (2025) Hindi(DD5.1-224Kbps) Completed Web Series HEVC 1080p ESub.mkv', { title: 'Silent Signals', year: 2025, resolution: '1080p', source: 'WEB' }],
    ['Mr.Robot.Movie.Season.Finale.2019.mkv', { title: 'Mr Robot Movie Season Finale', year: 2019 }],
  ])('%s', (input, expected) => {
    expect(parseName(input, 'movie')).toEqual(expected);
  });
});

describe('parseName — episodes', () => {
  it.each([
    ['Breaking Bad - S01E02 - Cat in the Bag.mkv', { title: 'Breaking Bad', season: 1, episode: 2 }],
    ['Breaking.Bad.S05E14.720p.HDTV.x264-GRP.mkv', { title: 'Breaking Bad', season: 5, episode: 14, resolution: '720p', source: 'HDTV', releaseGroup: 'GRP' }],
    ['The Office (US) - S02E01.mkv', { title: 'The Office (US)', season: 2, episode: 1 }],
    ['Show.Name.S01E01E02.mkv', { title: 'Show Name', season: 1, episode: 1, episodeEnd: 2 }],
    ['Show Name - S01E01-E03 - Pilot.mkv', { title: 'Show Name', season: 1, episode: 1, episodeEnd: 3 }],
    ['Show Name S01E01-02.mkv', { title: 'Show Name', season: 1, episode: 1, episodeEnd: 2 }],
    ['Show.S01E01.1080p.mkv', { title: 'Show', season: 1, episode: 1, resolution: '1080p' }],
    ['Show Name 1x02.mkv', { title: 'Show Name', season: 1, episode: 2 }],
    ['Doctor Who (2005) - S01E01.mkv', { title: 'Doctor Who', year: 2005, season: 1, episode: 1 }],
    ['S02E05.mkv', { season: 2, episode: 5 }],
    ['Show Season 2 Episode 7.mkv', { title: 'Show', season: 2, episode: 7 }],
    ['The.Daily.Show.2024.03.15.Guest.mkv', { title: 'The Daily Show', airDate: '2024-03-15', year: 2024 }],
    ['Video 1920x1080 S01E01.mkv', { title: 'Video 1920x1080', season: 1, episode: 1 }],
  ])('%s', (input, expected) => {
    expect(parseName(input, 'show')).toEqual(expected);
  });

  it.each([
    ['[SubsPlease] Sousou no Frieren - 05 (1080p) [ABCD1234].mkv', { title: 'Sousou no Frieren', absoluteEpisode: 5, releaseGroup: 'SubsPlease', resolution: '1080p' }],
    ['[Group] Show Name - 105v2 [720p].mkv', { title: 'Show Name', absoluteEpisode: 105, releaseGroup: 'Group', resolution: '720p' }],
    ['Show Name S2 - 05 [1080p].mkv', { title: 'Show Name', season: 2, episode: 5, resolution: '1080p' }],
    ['Show Name Episode 12.mkv', { title: 'Show Name', absoluteEpisode: 12 }],
    ['[Group] Show - S01E03 [1080p].mkv', { title: 'Show', season: 1, episode: 3, releaseGroup: 'Group', resolution: '1080p' }],
  ])('anime: %s', (input, expected) => {
    expect(parseName(input, 'show', { absolute: true })).toEqual(expected);
  });

  it('does not use absolute numbering unless asked', () => {
    expect(parseName('Show Name - 05.mkv', 'show')).toEqual({ title: 'Show Name - 05' });
  });
});

describe('folders and helpers', () => {
  it.each([
    ['Season 1', 1],
    ['Season 01 (2008)', 1],
    ['season.12', 12],
    ['S03', 3],
    ['Series 2', 2],
    ['Specials', 0],
    ['Season 0', 0],
    ['Staffel 4', 4],
    ['2nd Season', 2],
    ['Extras', undefined],
    ['Breaking Bad', undefined],
  ])('season folder %s', (input, expected) => {
    expect(parseSeasonFolder(input)).toBe(expected);
  });

  it.each([
    ['05.mkv', { episode: 5 }],
    ['E05 - Pilot.mkv', { episode: 5 }],
    ['Episode 5.mkv', { episode: 5 }],
    ['05 - Title.mkv', { episode: 5 }],
    ['01-02.mkv', { episode: 1, episodeEnd: 2 }],
    ['Pilot.mkv', undefined],
  ])('bare episode %s', (input, expected) => {
    expect(parseBareEpisode(input)).toEqual(expected);
  });

  it('builds stable identity and sort keys', () => {
    expect(matchKeyOf('Amélie', 2001)).toBe('amelie|2001');
    expect(matchKeyOf("Ocean's Eleven", 2001)).toBe(matchKeyOf('Oceans Eleven', 2001));
    expect(matchKeyOf('Fast & Furious')).toBe('fast and furious|');
    expect(sortTitleOf('The Matrix')).toBe('matrix');
    expect(sortTitleOf('A Quiet Place')).toBe('quiet place');
    expect(sortTitleOf('The')).toBe('the');
    expect(sortTitleOf('"Weird" Al')).toBe('weird" al');
  });

  it('cleans titles', () => {
    expect(cleanTitle('The.Matrix.')).toBe('The Matrix');
    expect(cleanTitle('S.H.I.E.L.D. Agents ')).toBe('S.H.I.E.L.D. Agents');
    expect(cleanTitle('Show  -  ')).toBe('Show');
  });

  it('recognises extras and junk folders', () => {
    expect(isExtraFile('Movie (2010)-trailer.mkv')).toBe(true);
    expect(isExtraFile('sample.mkv')).toBe(true);
    expect(isExtraFile('movie.sample.mkv')).toBe(true);
    expect(isExtraFile('Movie-behindthescenes.mp4')).toBe(true);
    expect(isExtraFile('The Interview (2014).mkv')).toBe(false);
    expect(isExtraFile('The Other.mkv')).toBe(false);
    expect(isSkippedDir('Featurettes')).toBe(true);
    expect(isSkippedDir('@eaDir')).toBe(true);
    expect(isSkippedDir('.hidden')).toBe(true);
    expect(isSkippedDir('Specials')).toBe(false);
  });
});
