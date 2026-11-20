import type {
  Artwork,
  CastMember,
  CrewMember,
  EpisodeMetadata,
  ExternalIds,
  MediaKind,
  MediaMetadata,
  SeasonMetadata,
} from '@streamora/plugin-sdk';

/*
 * Plugins are third-party code: everything they return is normalised here
 * before it is merged or stored, so a sloppy provider cannot corrupt the DB.
 */

const MAX_TEXT = 20_000;

export function cleanString(value: unknown, max = MAX_TEXT): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.replace(/\u0000/g, '').trim();
  return trimmed === '' ? undefined : trimmed.slice(0, max);
}

export function cleanNumber(value: unknown, min: number, max: number): number | undefined {
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n)) return undefined;
  return Math.min(Math.max(n, min), max);
}

function cleanInt(value: unknown, min: number, max: number): number | undefined {
  const n = cleanNumber(value, min, max);
  return n === undefined ? undefined : Math.round(n);
}

function cleanDate(value: unknown): string | undefined {
  const s = cleanString(value, 32);
  return s && /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : undefined;
}

function cleanStringList(value: unknown, maxItems = 50): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = [...new Set(value.map((v) => cleanString(v, 200)).filter((v): v is string => !!v))].slice(0, maxItems);
  return out.length ? out : undefined;
}

/** Artwork must be an absolute http(s) URL or an absolute local path. */
export function cleanArtworkRef(value: unknown): string | undefined {
  const s = cleanString(value, 4096);
  if (!s) return undefined;
  if (/^https?:\/\//i.test(s)) return s;
  if (s.startsWith('/') || /^[A-Za-z]:[\\/]/.test(s) || s.startsWith('\\\\')) return s;
  return undefined;
}

export function cleanExternalIds(value: unknown): ExternalIds | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const out: ExternalIds = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!/^[a-z0-9_-]{1,32}$/i.test(key)) continue;
    const v = typeof raw === 'number' ? String(raw) : cleanString(raw, 200);
    if (v) out[key.toLowerCase()] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

function cleanArtwork(value: unknown): Artwork | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const a = value as Record<string, unknown>;
  const out: Artwork = {
    poster: cleanArtworkRef(a.poster),
    backdrop: cleanArtworkRef(a.backdrop),
    logo: cleanArtworkRef(a.logo),
    thumb: cleanArtworkRef(a.thumb),
  };
  return Object.values(out).some(Boolean) ? stripUndefined(out) : undefined;
}

function cleanCast(value: unknown): CastMember[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value
    .map((v): CastMember | undefined => {
      if (!v || typeof v !== 'object') return undefined;
      const c = v as Record<string, unknown>;
      const name = cleanString(c.name, 200);
      if (!name) return undefined;
      return stripUndefined({
        name,
        character: cleanString(c.character, 300),
        order: cleanInt(c.order, 0, 10_000),
        photo: cleanArtworkRef(c.photo),
      });
    })
    .filter((c): c is CastMember => !!c)
    .slice(0, 100);
  return out.length ? out : undefined;
}

function cleanCrew(value: unknown): CrewMember[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value
    .map((v): CrewMember | undefined => {
      if (!v || typeof v !== 'object') return undefined;
      const c = v as Record<string, unknown>;
      const name = cleanString(c.name, 200);
      const job = cleanString(c.job, 100);
      if (!name || !job) return undefined;
      return stripUndefined({ name, job, department: cleanString(c.department, 100), photo: cleanArtworkRef(c.photo) });
    })
    .filter((c): c is CrewMember => !!c)
    .slice(0, 100);
  return out.length ? out : undefined;
}

export function stripUndefined<T extends object>(obj: T): T {
  for (const key of Object.keys(obj) as Array<keyof T>) if (obj[key] === undefined) delete obj[key];
  return obj;
}

export function sanitizeMetadata(raw: unknown, kind: MediaKind): MediaMetadata {
  const m = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return stripUndefined<MediaMetadata>({
    kind,
    title: cleanString(m.title, 500),
    originalTitle: cleanString(m.originalTitle, 500),
    sortTitle: cleanString(m.sortTitle, 500),
    year: cleanInt(m.year, 1870, 2200),
    releaseDate: cleanDate(m.releaseDate),
    tagline: cleanString(m.tagline, 1000),
    overview: cleanString(m.overview),
    genres: cleanStringList(m.genres),
    studios: cleanStringList(m.studios),
    contentRating: cleanString(m.contentRating, 32),
    rating: cleanNumber(m.rating, 0, 10),
    runtimeMinutes: cleanInt(m.runtimeMinutes, 0, 10_000),
    status: cleanString(m.status, 64),
    cast: cleanCast(m.cast),
    crew: cleanCrew(m.crew),
    artwork: cleanArtwork(m.artwork),
    externalIds: cleanExternalIds(m.externalIds),
  });
}

export function sanitizeEpisode(raw: unknown): EpisodeMetadata | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const e = raw as Record<string, unknown>;
  const seasonNumber = cleanInt(e.seasonNumber, 0, 10_000);
  const episodeNumber = cleanInt(e.episodeNumber, 0, 100_000);
  if (seasonNumber === undefined || episodeNumber === undefined) return undefined;
  return stripUndefined<EpisodeMetadata>({
    seasonNumber,
    episodeNumber,
    title: cleanString(e.title, 500),
    overview: cleanString(e.overview),
    airDate: cleanDate(e.airDate),
    runtimeMinutes: cleanInt(e.runtimeMinutes, 0, 10_000),
    rating: cleanNumber(e.rating, 0, 10),
    still: cleanArtworkRef(e.still),
    externalIds: cleanExternalIds(e.externalIds),
  });
}

export function sanitizeSeason(raw: unknown, seasonNumber: number): SeasonMetadata {
  const s = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const episodes = Array.isArray(s.episodes)
    ? s.episodes.map(sanitizeEpisode).filter((e): e is EpisodeMetadata => !!e)
    : undefined;
  return stripUndefined<SeasonMetadata>({
    seasonNumber,
    title: cleanString(s.title, 500),
    overview: cleanString(s.overview),
    airDate: cleanDate(s.airDate),
    poster: cleanArtworkRef(s.poster),
    externalIds: cleanExternalIds(s.externalIds),
    episodes: episodes?.length ? episodes : undefined,
  });
}

// ── merging: earlier (higher-priority) values win, later providers fill gaps ─

const isEmpty = (v: unknown) => v === undefined || (Array.isArray(v) && v.length === 0);

function fill<T extends object>(base: T, extra: Partial<T>, skip: ReadonlyArray<keyof T> = []): T {
  const out = { ...base };
  for (const key of Object.keys(extra) as Array<keyof T>) {
    if (skip.includes(key)) continue;
    if (isEmpty(out[key]) && !isEmpty(extra[key])) out[key] = extra[key] as T[keyof T];
  }
  return out;
}

function mergeIds(base?: ExternalIds, extra?: ExternalIds): ExternalIds | undefined {
  if (!base && !extra) return undefined;
  return { ...extra, ...base };
}

export function mergeMetadata(base: MediaMetadata, extra: MediaMetadata): MediaMetadata {
  const merged = fill(base, extra, ['kind', 'artwork', 'externalIds']);
  const artwork = base.artwork || extra.artwork ? fill<Artwork>(base.artwork ?? {}, extra.artwork ?? {}) : undefined;
  return stripUndefined({ ...merged, artwork, externalIds: mergeIds(base.externalIds, extra.externalIds) });
}

export function mergeSeason(base: SeasonMetadata, extra: SeasonMetadata): SeasonMetadata {
  const merged = fill(base, extra, ['seasonNumber', 'episodes', 'externalIds']);
  const byNumber = new Map<string, EpisodeMetadata>();
  for (const ep of [...(base.episodes ?? []), ...(extra.episodes ?? [])]) {
    const key = `${ep.seasonNumber}x${ep.episodeNumber}`;
    const existing = byNumber.get(key);
    byNumber.set(
      key,
      existing
        ? stripUndefined({ ...fill(existing, ep, ['externalIds']), externalIds: mergeIds(existing.externalIds, ep.externalIds) })
        : ep,
    );
  }
  const episodes = [...byNumber.values()].sort((a, b) => a.episodeNumber - b.episodeNumber);
  return stripUndefined({
    ...merged,
    externalIds: mergeIds(base.externalIds, extra.externalIds),
    episodes: episodes.length ? episodes : undefined,
  });
}
