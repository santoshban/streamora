import path from 'node:path';
import { VIDEO_EXTENSIONS } from './extensions.js';

/**
 * Filename / folder-name parsing for movies, TV and anime releases.
 *
 * Handles Plex/Jellyfin naming (`The Matrix (1999) {tmdb-603}`), scene
 * releases (`The.Matrix.1999.1080p.BluRay.x264-GRP`), TV numbering
 * (`S01E02`, `1x02`, `S01E01-E02`), date-based episodes and fansub anime
 * (`[Group] Show - 05 (1080p) [CRC32]`).
 */

export interface ParsedName {
  title?: string;
  year?: number;
  season?: number;
  episode?: number;
  /** Last episode of a multi-episode file. */
  episodeEnd?: number;
  /** Absolute episode number (anime, `Show - 105`). */
  absoluteEpisode?: number;
  /** Date-based episodes (`Show.2024.03.15.mkv`), `YYYY-MM-DD`. */
  airDate?: string;
  resolution?: string;
  source?: string;
  releaseGroup?: string;
  edition?: string;
  /** Ids embedded in the name: `{tmdb-603}`, `[imdbid-tt0133093]`, `{tvdb-81189}`. */
  externalIds?: Record<string, string>;
}

const MAX_YEAR = new Date().getFullYear() + 2;
const isYear = (n: number) => n >= 1880 && n <= MAX_YEAR;

/** Download-site tags: `(Site.CA) Title…`, `[Site.MX] Title…`, `www.site.org - Title…`. */
const SITE_TLDS =
  'org|com|net|ca|to|mx|bz|gg|in|me|io|cc|tv|ws|lol|xyz|site|co|uk|pw|ag|ch|se|nu|fun|club|live|vip|link|one|win|top|pro|info|biz|ru|eu|am|cx|li|is|sx|tw|st';
const SITE_DOMAIN = String.raw`(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:${SITE_TLDS})`;
const SITE_PREFIX = new RegExp(String.raw`^\s*(?:[([]\s*${SITE_DOMAIN}\s*[)\]]|${SITE_DOMAIN}\s+-)\s*`, 'i');

/** Season-pack leftovers in a movie name: `Show S01 (Ep.01-07)`, `Show Season 2`. */
const SEASON_PACK_SUFFIX = /\s+(?:S\d{1,2}(?:\s*E\d{1,3})?|Season\s*\d{1,2})(?:\s*\(?\s*Ep\.?\s*\d+(?:\s*-\s*\d+)?\s*\)?)?\s*$/i;

const ID_TAG = /[[{(]\s*(tmdb|imdb|tvdb)(?:id)?\s*[-=:]\s*(tt\d+|\d+)\s*[\]})]/gi;
const EDITION_TAG = /\{edition-([^}]+)\}/i;

const EDITIONS: Array<[RegExp, string]> = [
  [/\bdirector'?s[ ._-]?cut\b/i, "Director's Cut"],
  [/\bextended[ ._-]?(?:cut|edition)?\b/i, 'Extended'],
  [/\b(?:unrated|uncut)\b/i, 'Unrated'],
  [/\btheatrical(?:[ ._-]?cut)?\b/i, 'Theatrical'],
  [/\bfinal[ ._-]?cut\b/i, 'Final Cut'],
  [/\bultimate[ ._-]?(?:cut|edition)\b/i, 'Ultimate'],
  [/\bspecial[ ._-]?edition\b/i, 'Special Edition'],
  [/\bcollector'?s[ ._-]?edition\b/i, "Collector's Edition"],
  [/\banniversary[ ._-]?edition\b/i, 'Anniversary Edition'],
  [/\bcriterion\b/i, 'Criterion'],
  [/\bimax\b/i, 'IMAX'],
  [/\bremastered\b/i, 'Remastered'],
];

const RESOLUTIONS: Array<[RegExp, string]> = [
  [/\b(?:2160p|4k|uhd)\b/i, '4K'],
  [/\b1080[pi]\b/i, '1080p'],
  [/\b720p\b/i, '720p'],
  [/\b(?:576|480)[pi]\b/i, '480p'],
];

const SOURCES: Array<[RegExp, string]> = [
  [/\bremux\b/i, 'Remux'],
  [/\b(?:blu[ ._-]?ray|bdrip|brrip|bd25|bd50|bdmv)\b/i, 'BluRay'],
  [/\bweb[ ._-]?(?:dl|rip)?\b/i, 'WEB'],
  [/\bhdtv\b/i, 'HDTV'],
  [/\b(?:dvd[ ._-]?rip|dvd(?:5|9)?)\b/i, 'DVD'],
  [/\bhdrip\b/i, 'HDRip'],
];

/**
 * Tokens that never belong to a title. The title ends at the first one
 * (or at the year / episode marker, whichever comes first).
 */
const RELEASE_TOKEN = new RegExp(
  '(?:^|[\\s._\\-[(])(?:' +
    [
      '2160p', '1080[pi]', '720p', '576[pi]', '480[pi]', '4k', 'uhd',
      'blu[ ._-]?ray', 'bdrip', 'brrip', 'remux', 'web[ ._-]?dl', 'webrip', 'web', 'hdtv', 'dvd[ ._-]?rip', 'dvd', 'hdrip',
      'x26[45]', 'h[ .]?26[45]', 'hevc', 'avc', 'xvid', 'divx', '10[ ._-]?bit', 'hdr10\\+?', 'hdr', 'dv', 'dovi',
      'aac(?:[ .]?\\d\\.\\d)?', 'ac3', 'e?ac-?3', 'dts(?:-hd)?', 'truehd', 'atmos', 'dd[p+]?\\d[ .]\\d', 'flac',
      'proper', 'repack', 'limited', 'internal', 'multi', 'dubbed', 'subbed', 'complete',
      "director'?s[ ._-]?cut", 'extended', 'unrated', 'uncut', 'theatrical', 'remastered', 'imax', 'criterion',
    ].join('|') +
    ')(?=$|[\\s._\\-\\])])',
  'i',
);

function stripExtension(name: string): string {
  const ext = path.extname(name);
  return ext && VIDEO_EXTENSIONS.has(ext.toLowerCase()) ? name.slice(0, -ext.length) : name;
}

/** Dots/underscores → spaces (keeping acronyms such as `S.H.I.E.L.D.`), collapse whitespace. */
export function cleanTitle(raw: string): string {
  let s = raw;
  // Protect acronyms: letters separated by single dots.
  s = s.replace(/(?<![A-Za-z])((?:[A-Za-z]\.){2,}[A-Za-z]?)(?![A-Za-z])/g, (m) => m.replace(/\./g, '\u0001'));
  if (!/\s/.test(s.replace(/_/g, ''))) s = s.replace(/\./g, ' ');
  s = s.replace(/_/g, ' ').replace(/\u0001/g, '.');
  s = s.replace(/\s*\[[^\]]*\]\s*/g, ' '); // stray [tags]
  s = s.replace(/\(\s*\)/g, ' ');
  s = s.replace(/\s+/g, ' ');
  s = s.replace(/^[\s\-–—:,.]+|[\s\-–—:,(]+$/g, '');
  return s.trim();
}

function extractIds(input: string): { rest: string; ids?: Record<string, string> } {
  const ids: Record<string, string> = {};
  const rest = input.replace(ID_TAG, (_m, provider: string, value: string) => {
    const key = provider.toLowerCase();
    if (key !== 'imdb' || /^tt\d+$/.test(value)) ids[key] = value;
    return ' ';
  });
  return { rest, ids: Object.keys(ids).length ? ids : undefined };
}

function firstMatch<T>(input: string, table: Array<[RegExp, T]>): T | undefined {
  for (const [re, value] of table) if (re.test(input)) return value;
  return undefined;
}

/** The release year: a bracketed year wins, otherwise the last plausible year that is not the whole title. */
function findYear(s: string): { year: number; index: number } | undefined {
  const bracketed = /[([]((?:18|19|20)\d{2})[)\]]/g;
  for (let m = bracketed.exec(s); m; m = bracketed.exec(s)) {
    const year = Number(m[1]);
    if (isYear(year) && m.index > 0) return { year, index: m.index };
  }
  const bare = /(?<![\p{L}\p{N}])((?:18|19|20)\d{2})(?![\p{L}\p{N}])/gu;
  let found: { year: number; index: number } | undefined;
  for (let m = bare.exec(s); m; m = bare.exec(s)) {
    const year = Number(m[1]);
    const before = s.slice(0, m.index).replace(/[\s._\-[(]+$/, '');
    if (isYear(year) && before.length > 0) found = { year, index: m.index };
  }
  return found;
}

interface EpisodeMatch {
  index: number;
  season?: number;
  episode?: number;
  episodeEnd?: number;
  absoluteEpisode?: number;
  airDate?: string;
}

function findEpisode(s: string, allowAbsolute: boolean): EpisodeMatch | undefined {
  // S01E02, S01E02E03, S01E02-E03, S01E02-03, S01.E02
  const sxe = /(?<![a-z\d])s(\d{1,4})[ ._-]?e(\d{1,4})((?:[ ._-]?(?:e|-)\d{1,4}(?![\dpi]))*)/i.exec(s);
  if (sxe) {
    const season = Number(sxe[1]);
    const episode = Number(sxe[2]);
    const extra = [...(sxe[3] ?? '').matchAll(/\d{1,4}/g)].map((m) => Number(m[0])).filter((n) => n > episode);
    return { index: sxe.index, season, episode, episodeEnd: extra.length ? Math.max(...extra) : undefined };
  }

  // 1x02, 01x02-03
  const nx = /(?<![\dx])(\d{1,2})x(\d{2,3})(?:-(\d{2,3}))?(?![\dp])/i.exec(s);
  if (nx) {
    const episode = Number(nx[2]);
    const end = nx[3] ? Number(nx[3]) : undefined;
    return { index: nx.index, season: Number(nx[1]), episode, episodeEnd: end && end > episode ? end : undefined };
  }

  // "Season 1 Episode 2"
  const long = /season[ ._-]?(\d{1,3})[ ._-]*episode[ ._-]?(\d{1,4})/i.exec(s);
  if (long) return { index: long.index, season: Number(long[1]), episode: Number(long[2]) };

  // Date-based: 2024.03.15 / 2024-03-15
  const date = /(?<!\d)((?:19|20)\d{2})[ ._-](\d{2})[ ._-](\d{2})(?!\d)/.exec(s);
  if (date) {
    const [y, m, d] = [Number(date[1]), Number(date[2]), Number(date[3])];
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      return { index: date.index, airDate: `${date[1]}-${date[2]}-${date[3]}` };
    }
  }

  if (!allowAbsolute) return undefined;

  // "Show S2 - 05", "Show 2nd Season - 05"
  const seasonHint = /(?:^|\s)(?:s(\d{1,2})|(\d)(?:st|nd|rd|th)[ ._-]season|season[ ._-]?(\d{1,2}))(?=\s*-\s*\d)/i.exec(s);
  // "Show - 05", "Show - 05v2", "Show - 105 [1080p]"
  const dash = /\s-\s(\d{1,4})(?:v\d)?(?=$|[\s[(.])/.exec(s);
  if (dash) {
    const n = Number(dash[1]);
    const season = seasonHint ? Number(seasonHint[1] ?? seasonHint[2] ?? seasonHint[3]) : undefined;
    const index = seasonHint && seasonHint.index < dash.index ? seasonHint.index : dash.index;
    return season !== undefined ? { index, season, episode: n } : { index, absoluteEpisode: n };
  }
  // "Show Episode 5", "Show Ep. 05", "Show E05"
  const ep = /(?:^|[\s._-])(?:episode|ep\.?|e)[ ._-]?(\d{1,4})(?![\dp])/i.exec(s);
  if (ep) return { index: ep.index, absoluteEpisode: Number(ep[1]) };
  return undefined;
}

/**
 * Parses a file or folder name. `kind` selects which numbering rules apply:
 * `movie` never looks for episodes; `show` accepts absolute numbering only
 * when `absolute` is set (anime libraries, or as a fallback).
 */
export function parseName(input: string, kind: 'movie' | 'show' = 'movie', options: { absolute?: boolean } = {}): ParsedName {
  const out: ParsedName = {};
  let s = stripExtension(input).normalize('NFC').replace(SITE_PREFIX, '');

  const edition = EDITION_TAG.exec(s);
  if (edition) {
    out.edition = edition[1]!.trim();
    s = s.replace(EDITION_TAG, ' ');
  }
  const { rest, ids } = extractIds(s);
  s = rest;
  if (ids) out.externalIds = ids;

  // Leading fansub group: "[SubsPlease] Show - 05"
  const leadingGroup = /^\s*\[([^\]]+)\]\s*/.exec(s);
  if (leadingGroup && !/^\d{4}$/.test(leadingGroup[1]!)) {
    out.releaseGroup = leadingGroup[1]!.trim();
    s = s.slice(leadingGroup[0].length);
  }

  out.resolution = firstMatch(s, RESOLUTIONS);
  out.source = firstMatch(s, SOURCES);
  out.edition ??= firstMatch(s, EDITIONS);

  // Trailing scene group: "...x264-GROUP" (no spaces around the dash).
  if (!out.releaseGroup) {
    const group = /(?<=\S)-([A-Za-z0-9][A-Za-z0-9_]{1,30})(?:\[[^\]]*\])?$/.exec(s.trim());
    if (group && !/^(?:dl|rip|ray|hd|\d+|e\d+)$/i.test(group[1]!) && RELEASE_TOKEN.test(s)) {
      out.releaseGroup = group[1];
      s = s.trim().slice(0, -group[0].length);
    }
  }

  let cut = s.length;
  if (kind === 'show') {
    const ep = findEpisode(s, options.absolute === true);
    if (ep) {
      cut = Math.min(cut, ep.index);
      if (ep.season !== undefined) out.season = ep.season;
      if (ep.episode !== undefined) out.episode = ep.episode;
      if (ep.episodeEnd !== undefined) out.episodeEnd = ep.episodeEnd;
      if (ep.absoluteEpisode !== undefined) out.absoluteEpisode = ep.absoluteEpisode;
      if (ep.airDate) {
        out.airDate = ep.airDate;
        out.year = Number(ep.airDate.slice(0, 4));
      }
    }
  }

  const titleZone = s.slice(0, cut);
  const year = findYear(titleZone);
  if (year) {
    out.year ??= year.year;
    cut = Math.min(cut, year.index);
  }
  const token = RELEASE_TOKEN.exec(s.slice(0, cut));
  if (token && token.index > 0) cut = Math.min(cut, token.index);

  let title = cleanTitle(s.slice(0, cut));
  if (kind === 'movie') title = title.replace(SEASON_PACK_SUFFIX, '').trim();
  if (title) out.title = title;

  for (const key of Object.keys(out) as Array<keyof ParsedName>) if (out[key] === undefined) delete out[key];
  return out;
}

/** `Season 1`, `Season 01 (2008)`, `S01`, `Series 2`, `Specials` → season number. */
export function parseSeasonFolder(name: string): number | undefined {
  const s = name.trim();
  if (/^specials?$/i.test(s) || /^season[ ._-]?0+$/i.test(s)) return 0;
  const m =
    /^(?:season|series|saison|staffel|temporada|stagione|seizoen)[ ._-]*(\d{1,4})\b/i.exec(s) ??
    /^s(\d{1,3})$/i.exec(s) ??
    /^(\d{1,2})(?:st|nd|rd|th)[ ._-]season$/i.exec(s);
  return m ? Number(m[1]) : undefined;
}

/** Bare episode files inside a season folder: `05.mkv`, `E05 - Title.mkv`, `Episode 5.mkv`, `05 - Title.mkv`. */
export function parseBareEpisode(fileName: string): { episode: number; episodeEnd?: number } | undefined {
  const s = stripExtension(fileName).trim();
  const m = /^(?:e|ep\.?|episode)?[ ._-]?(\d{1,4})(?:[ ._-]?(?:-|e)(\d{1,4}))?(?=$|[\s._-])/i.exec(s);
  if (!m) return undefined;
  const episode = Number(m[1]);
  if (isYear(episode) && s.length === 4) return undefined;
  const end = m[2] ? Number(m[2]) : undefined;
  return { episode, episodeEnd: end && end > episode ? end : undefined };
}

// ── identity helpers ─────────────────────────────────────────────────────────

/** Lowercase, accent-free, punctuation-free form used for grouping (`matchKey`). */
export function normalizeTitle(title: string): string {
  return title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['’`]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export function matchKeyOf(title: string, year?: number): string {
  return `${normalizeTitle(title)}|${year ?? ''}`;
}

const ARTICLES = /^(?:the|a|an)\s+/i;

/** Sort key: lowercase, accent-free, without a leading English article. */
export function sortTitleOf(title: string): string {
  const base = title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/^[^\p{L}\p{N}]+/u, '');
  return base.replace(ARTICLES, '').trim() || base.trim();
}
