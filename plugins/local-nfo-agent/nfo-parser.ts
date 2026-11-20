import { XMLParser, XMLValidator } from 'fast-xml-parser';
import type { CastMember, ExternalIds } from '@streamora/plugin-sdk';

export type NfoKind = 'movie' | 'tvshow' | 'episodedetails' | 'season' | 'url-only';

export interface ParsedNfo {
  kind: NfoKind;
  title?: string;
  originalTitle?: string;
  sortTitle?: string;
  year?: number;
  releaseDate?: string;
  overview?: string;
  tagline?: string;
  runtimeMinutes?: number;
  contentRating?: string;
  rating?: number;
  status?: string;
  genres: string[];
  studios: string[];
  directors: string[];
  writers: string[];
  actors: CastMember[];
  externalIds: ExternalIds;
  /** Remote poster/thumb URLs found in the NFO (`<thumb>`). */
  posterUrls: string[];
  /** Remote fanart URLs (`<fanart><thumb>`). */
  fanartUrls: string[];
  season?: number;
  episode?: number;
}

const ROOT_KINDS = ['movie', 'tvshow', 'episodedetails', 'season'] as const;
const ARRAY_TAGS = new Set([
  'genre', 'studio', 'director', 'credits', 'writer', 'actor', 'uniqueid', 'thumb', 'rating', 'country', 'tag',
  'episodedetails', 'movie', 'tvshow', 'season',
]);

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  processEntities: true,
  htmlEntities: true,
  isArray: (name) => ARRAY_TAGS.has(name),
});

type Node = Record<string, unknown>;

function text(value: unknown): string | undefined {
  if (Array.isArray(value)) return text(value[0]);
  if (typeof value === 'string') return value.trim() || undefined;
  if (typeof value === 'number') return String(value);
  if (value && typeof value === 'object' && '#text' in value) return text((value as Node)['#text']);
  return undefined;
}

function list(value: unknown): string[] {
  const items = Array.isArray(value) ? value : value === undefined ? [] : [value];
  // Some scrapers write "Action / Adventure" into a single tag.
  return [...new Set(items.flatMap((v) => (text(v) ?? '').split(/\s+\/\s+/)).map((s) => s.trim()).filter(Boolean))];
}

function int(value: unknown): number | undefined {
  const m = text(value)?.match(/-?\d+/);
  return m ? Number(m[0]) : undefined;
}

function date(value: unknown): string | undefined {
  const s = text(value);
  return s && /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : undefined;
}

const isUrl = (s?: string): s is string => !!s && /^https?:\/\//i.test(s);

/** "Rated PG-13", "US:PG-13 / US:Rated PG-13", "DE:FSK 16" → "PG-13" / "FSK 16". */
export function normalizeCertification(raw?: string): string | undefined {
  if (!raw) return undefined;
  const first = raw.split('/')[0]!.trim();
  const withoutCountry = first.replace(/^[A-Za-z]{2}:/, '').trim();
  const cleaned = withoutCountry.replace(/^Rated\s+/i, '').trim();
  return cleaned || undefined;
}

function parseRating(node: Node): number | undefined {
  const ratings = (node.ratings as Node | undefined)?.rating;
  if (Array.isArray(ratings) && ratings.length) {
    const chosen = (ratings as Node[]).find((r) => r['@_default'] === 'true') ?? (ratings[0] as Node);
    const value = Number(text(chosen.value));
    const max = Number(chosen['@_max'] ?? 10) || 10;
    if (Number.isFinite(value) && value > 0) return Math.round((value / max) * 100) / 10;
  }
  const legacy = Number(text(node.rating));
  return Number.isFinite(legacy) && legacy > 0 ? Math.min(legacy, 10) : undefined;
}

function parseIds(node: Node, kind: NfoKind): ExternalIds {
  const ids: ExternalIds = {};
  const uniqueIds = Array.isArray(node.uniqueid) ? (node.uniqueid as unknown[]) : [];
  for (const entry of uniqueIds) {
    const value = text(entry);
    if (!value) continue;
    const type = (entry && typeof entry === 'object' ? String((entry as Node)['@_type'] ?? '') : '').toLowerCase();
    const key = type || (/^tt\d+$/.test(value) ? 'imdb' : '');
    if (key && !ids[key]) ids[key] = value;
  }
  const imdb = text(node.imdbid) ?? text(node.imdb_id);
  if (imdb && !ids.imdb) ids.imdb = imdb;
  const tmdb = text(node.tmdbid);
  if (tmdb && !ids.tmdb) ids.tmdb = tmdb;
  const tvdb = text(node.tvdbid);
  if (tvdb && !ids.tvdb) ids.tvdb = tvdb;

  // Legacy <id>: IMDb for movies, TVDB for shows/episodes.
  const legacy = text(node.id);
  if (legacy) {
    if (/^tt\d+$/.test(legacy)) ids.imdb ??= legacy;
    else if (/^\d+$/.test(legacy) && kind !== 'movie') ids.tvdb ??= legacy;
  }
  for (const [k, v] of Object.entries(ids)) if (!v || (k === 'imdb' && !/^tt\d+$/.test(v))) delete ids[k];
  return ids;
}

function parseActors(node: Node): CastMember[] {
  const actors = Array.isArray(node.actor) ? (node.actor as Node[]) : [];
  return actors
    .map((a, i): CastMember | undefined => {
      const name = text(a.name);
      if (!name) return undefined;
      const photo = text(a.thumb);
      return {
        name,
        character: text(a.role),
        order: int(a.order) ?? i,
        ...(isUrl(photo) ? { photo } : {}),
      };
    })
    .filter((a): a is CastMember => !!a);
}

function mapNode(kind: Exclude<NfoKind, 'url-only'>, node: Node): ParsedNfo {
  const thumbs = (Array.isArray(node.thumb) ? node.thumb : []) as unknown[];
  const posterUrls = thumbs
    .filter((t) => {
      const aspect = t && typeof t === 'object' ? (t as Node)['@_aspect'] : undefined;
      return aspect === undefined || aspect === 'poster';
    })
    .map(text)
    .filter(isUrl);
  const fanart = (node.fanart as Node | undefined)?.thumb;
  const fanartUrls = (Array.isArray(fanart) ? fanart : []).map(text).filter(isUrl);

  const releaseDate = date(node.premiered) ?? date(node.releasedate) ?? date(node.aired);
  return {
    kind,
    title: text(node.title),
    originalTitle: text(node.originaltitle),
    sortTitle: text(node.sorttitle),
    year: int(node.year) ?? (releaseDate ? Number(releaseDate.slice(0, 4)) : undefined),
    releaseDate,
    overview: text(node.plot) ?? text(node.outline),
    tagline: text(node.tagline),
    runtimeMinutes: int(node.runtime),
    contentRating: normalizeCertification(text(node.mpaa) ?? text(node.certification)),
    rating: parseRating(node),
    status: text(node.status),
    genres: list(node.genre),
    studios: list(node.studio),
    directors: list(node.director),
    writers: [...new Set([...list(node.credits), ...list(node.writer)])],
    actors: parseActors(node),
    externalIds: parseIds(node, kind),
    posterUrls,
    fanartUrls,
    season: int(node.season),
    episode: int(node.episode),
  };
}

/** IMDb/TMDB ids from a "URL-only" NFO or the URL line Kodi allows after the XML. */
export function extractIdsFromText(content: string): ExternalIds {
  const ids: ExternalIds = {};
  const imdb = content.match(/imdb\.com\/title\/(tt\d{5,})/i) ?? content.match(/\b(tt\d{7,})\b/);
  if (imdb) ids.imdb = imdb[1]!;
  const tmdb = content.match(/themoviedb\.org\/(?:movie|tv)\/(\d+)/i);
  if (tmdb) ids.tmdb = tmdb[1]!;
  return ids;
}

const emptyNfo = (externalIds: ExternalIds): ParsedNfo => ({
  kind: 'url-only',
  genres: [],
  studios: [],
  directors: [],
  writers: [],
  actors: [],
  externalIds,
  posterUrls: [],
  fanartUrls: [],
});

/**
 * Parses an NFO file. Returns one entry per root element (multi-episode files
 * contain several `<episodedetails>`), or a single `url-only` entry.
 */
export function parseNfo(content: string): ParsedNfo[] {
  const body = content
    .replace(/^﻿/, '')
    .replace(/<\?xml[^>]*\?>/gi, '')
    .replace(/<!DOCTYPE[^>]*>/gi, '');
  const wrapped = `<nfo-root>${body}</nfo-root>`;

  if (/<(movie|tvshow|episodedetails|season)[\s>]/i.test(body) && XMLValidator.validate(wrapped) === true) {
    const root = (parser.parse(wrapped) as Node)['nfo-root'] as Node | undefined;
    if (root && typeof root === 'object') {
      const out: ParsedNfo[] = [];
      for (const kind of ROOT_KINDS) {
        const nodes = root[kind];
        for (const node of Array.isArray(nodes) ? nodes : []) {
          if (node && typeof node === 'object') out.push(mapNode(kind, node as Node));
        }
      }
      if (out.length) {
        // Kodi allows a scraper URL after the closing tag.
        const trailing = text(root['#text']);
        if (trailing) {
          const extra = extractIdsFromText(trailing);
          for (const nfo of out) nfo.externalIds = { ...extra, ...nfo.externalIds };
        }
        return out;
      }
    }
  }

  const ids = extractIdsFromText(body);
  return Object.keys(ids).length ? [emptyNfo(ids)] : [];
}
