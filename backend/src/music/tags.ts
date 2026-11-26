import path from 'node:path';
import { normalizeTitle, sortTitleOf } from '../media/parse.js';

/** What a track is, from its tags, its file name and the folders above it. */
export interface TrackTags {
  title: string;
  /** Full credit as tagged ("A feat. B", "A, B"). */
  artist: string;
  /** First credited artist: the one the track is filed under. */
  primaryArtist: string;
  albumArtist: string;
  /** True when the album artist came from a tag (not guessed). */
  albumArtistTagged: boolean;
  album: string;
  trackNumber: number | null;
  discNumber: number | null;
  year: number | null;
  genres: string[];
  compilation: boolean;
}

export const UNKNOWN_ARTIST = 'Unknown Artist';
export const VARIOUS_ARTISTS = 'Various Artists';

/** One artist/album per library however it is spelt: "The Beatles" = "the beatles". */
export function musicKeyOf(name: string): string {
  return normalizeTitle(name) || name.trim().toLowerCase();
}

export const musicSortOf = (name: string) => sortTitleOf(name) || name.toLowerCase();

/** `CD1`, `Disc 2`, `Disk 03`: a multi-disc album's sub-folder. */
export const DISC_FOLDER = /^(?:cd|dis[ck])\s*[-_.]?\s*(\d{1,2})$/i;

const first = (tags: Record<string, string>, ...keys: string[]): string | undefined => {
  for (const k of keys) {
    const raw: unknown = tags[k];
    const v = raw === undefined || raw === null ? '' : String(raw).trim();
    if (v) return v;
  }
  return undefined;
};

/** "3/12" → 3, "03" → 3. */
function leadingNumber(value: string | undefined): number | null {
  const m = /^\s*(\d{1,4})/.exec(value ?? '');
  const n = m ? Number(m[1]) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** "2019", "2019-05-03", "05/03/2019" → 2019. */
function yearOf(value: string | undefined): number | null {
  const m = /\b(1[89]\d{2}|20\d{2})\b/.exec(value ?? '');
  return m ? Number(m[1]) : null;
}

/** Multi-value tags arrive joined with ";" (Vorbis comments) or NUL (ID3v2.4). */
const splitValues = (value: string) =>
  value
    .split(/\s*[;\u0000]\s*/)
    .map((s) => s.trim())
    .filter(Boolean);

/** "A feat. B" → "A". "Simon & Garfunkel" and "Earth, Wind & Fire" stay whole. */
function primaryOf(credit: string): string {
  const head = splitValues(credit)[0] ?? credit;
  return head.split(/\s+(?:feat\.?|ft\.?|featuring)\s+/i)[0]!.trim() || head;
}

function genresOf(value: string | undefined): string[] {
  if (!value) return [];
  const out: string[] = [];
  for (const raw of value.split(/\s*[;/|,\u0000]\s*/)) {
    // ID3v1 numeric genres are already names in ffprobe's output; drop leftovers like "(17)".
    const g = raw.replace(/^\(\d+\)\s*/, '').trim();
    if (g && !/^\d+$/.test(g) && !out.some((o) => o.toLowerCase() === g.toLowerCase())) out.push(g);
  }
  return out.slice(0, 5);
}

interface FromName {
  disc?: number;
  track?: number;
  artist?: string;
  title: string;
  /** Everything after the track number. */
  rest: string;
}

/**
 * "01 - Title", "1-03 Title", "05. Artist - Title", "Artist - Title". A bare
 * number only counts as a track number with a leading zero, so "50 Cent - …"
 * keeps its name.
 */
export function parseTrackFileName(stem: string): FromName {
  const name = stem.replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
  let disc: number | undefined;
  let track: number | undefined;
  let rest = name;
  const discTrack = /^(\d)[-.](\d{2})\s*[-.)\]]?\s+(.+)$/.exec(name);
  const punct = /^(?:(\d)[-.](?=\d))?(\d{1,3})\s*[-.)\]]\s*(.+)$/.exec(name);
  const zero = /^(0\d|\d{3})\s+(.+)$/.exec(name);
  if (discTrack) {
    disc = Number(discTrack[1]);
    track = Number(discTrack[2]);
    rest = discTrack[3]!;
  } else if (punct) {
    disc = punct[1] ? Number(punct[1]) : undefined;
    track = Number(punct[2]);
    rest = punct[3]!;
  } else if (zero) {
    track = Number(zero[1]);
    rest = zero[2]!;
  }
  rest = rest.trim() || name;
  const dash = rest.split(/\s+-\s+/);
  if (dash.length >= 2) return { disc, track, artist: dash[0]!.trim(), title: dash.slice(1).join(' - ').trim(), rest };
  return { disc, track, title: rest, rest };
}

/** "Abbey Road (1969)", "[1969] Abbey Road", "Artist - Album" folder names. */
export function parseAlbumFolder(name: string): { artist?: string; album: string; year?: number } {
  let album = name.trim();
  let year: number | undefined;
  const trailing = /^(.*?)\s*[([]\s*((?:19|20)\d{2})\s*[)\]]\s*$/.exec(album);
  const leading = /^[([]?\s*((?:19|20)\d{2})\s*[)\]]?\s*[-.]?\s+(.+)$/.exec(album);
  if (trailing?.[1]) {
    album = trailing[1];
    year = Number(trailing[2]);
  } else if (leading?.[2]) {
    album = leading[2];
    year = Number(leading[1]);
  }
  const dash = album.split(/\s+-\s+/);
  if (dash.length === 2) return { artist: dash[0]!.trim(), album: dash[1]!.trim(), year };
  return { album: album.trim() || name, year };
}

/**
 * Reads a track's identity. Tags win; without them the Plex-style layout
 * `Artist/Album/NN - Title.ext` (optionally with a `CD1` folder) fills the gaps.
 */
export function readTrackTags(rawTags: Record<string, string> | undefined, file: string, root: string): TrackTags {
  const tags = rawTags ?? {};
  const stem = path.basename(file, path.extname(file));
  const fromName = parseTrackFileName(stem);

  // Folders between the library root and the file.
  const dirs = path.relative(root, path.dirname(file)).split(/[\\/]/).filter(Boolean);
  if (dirs.length && DISC_FOLDER.test(dirs[dirs.length - 1]!)) dirs.pop();
  const albumFolder = dirs.length ? parseAlbumFolder(dirs[dirs.length - 1]!) : undefined;
  const artistFolder = dirs.length >= 2 ? dirs[dirs.length - 2] : albumFolder?.artist;
  const discFolder = DISC_FOLDER.exec(path.basename(path.dirname(file)));

  const taggedArtist = first(tags, 'artist', 'performer', 'album_artist', 'albumartist', 'album artist');
  const folderArtist = artistFolder ?? albumFolder?.artist;
  // "Artist - Title" names only override the folder when nothing better is known.
  const nameArtist =
    fromName.artist && (!folderArtist || musicKeyOf(fromName.artist) === musicKeyOf(folderArtist)) ? fromName.artist : undefined;
  const artist = taggedArtist ?? nameArtist ?? folderArtist ?? UNKNOWN_ARTIST;
  const credit = splitValues(artist).join(', ') || artist;

  const title = first(tags, 'title') ?? (nameArtist ? fromName.title : fromName.rest);

  const compilation = /^(?:1|true|yes)$/i.test(first(tags, 'compilation', 'tcmp', 'itunescompilation') ?? '');
  const taggedAlbumArtist = first(tags, 'album_artist', 'albumartist', 'album artist', 'band');
  const albumArtist = taggedAlbumArtist ? primaryOf(taggedAlbumArtist) : compilation ? VARIOUS_ARTISTS : primaryOf(artist);

  // Loose files without an album tag become singles named after the track.
  const album = first(tags, 'album') ?? albumFolder?.album ?? title;

  return {
    title,
    artist: credit,
    primaryArtist: primaryOf(artist),
    albumArtist,
    albumArtistTagged: !!taggedAlbumArtist || compilation,
    album,
    trackNumber: leadingNumber(first(tags, 'track', 'tracknumber', 'trck')) ?? fromName.track ?? null,
    discNumber:
      leadingNumber(first(tags, 'disc', 'discnumber', 'disk', 'tpos')) ?? fromName.disc ?? (discFolder ? Number(discFolder[1]) : null),
    year: yearOf(first(tags, 'date', 'year', 'originaldate', 'original_year', 'tdrc', 'tyer')) ?? albumFolder?.year ?? null,
    genres: genresOf(first(tags, 'genre')),
    compilation,
  };
}

/** Lyrics stored in tags: `lyrics`, `lyrics-eng`, `unsyncedlyrics`, `©lyr`. */
export function embeddedLyrics(tags: Record<string, string> | undefined): string | null {
  if (!tags) return null;
  for (const [key, value] of Object.entries(tags)) {
    if (/^(?:lyrics(?:-\w+)?|unsyncedlyrics|uslt|©lyr|syncedlyrics)$/i.test(key) && value.trim()) return value;
  }
  return null;
}
