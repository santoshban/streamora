import fs from 'node:fs/promises';
import path from 'node:path';

export interface LyricLine {
  /** Seconds from the start of the track. */
  time: number;
  text: string;
}

export interface Lyrics {
  /** Time-stamped lines (from an `.lrc` file or LRC text in a tag), or null. */
  synced: LyricLine[] | null;
  /** The words without timestamps. */
  plain: string;
  source: 'lrc' | 'embedded';
}

const STAMP = /\[(\d{1,3}):(\d{1,2}(?:[.:]\d{1,3})?)\]/g;
const META = /^\[(ar|ti|al|au|by|length|re|ve|#|offset):?([^\]]*)\]\s*$/i;

/** Parses LRC text: `[01:02.50]line`, several stamps per line, `[offset:+250]`, word stamps `<01:02.50>`. */
export function parseLrc(text: string): { synced: LyricLine[] | null; plain: string } {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  let offset = 0;
  const synced: LyricLine[] = [];
  const plain: string[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    const meta = META.exec(line);
    if (meta) {
      if (meta[1]!.toLowerCase() === 'offset') offset = Number(meta[2]) / 1000 || 0;
      continue;
    }
    const stamps: number[] = [];
    let last = 0;
    STAMP.lastIndex = 0;
    for (let m = STAMP.exec(line); m; m = STAMP.exec(line)) {
      if (m.index !== last) break; // stamps only count at the start of a line
      stamps.push(Number(m[1]) * 60 + Number(m[2]!.replace(':', '.')));
      last = STAMP.lastIndex;
    }
    const words = line
      .slice(last)
      .replace(/<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (stamps.length) {
      for (const t of stamps) synced.push({ time: Math.max(0, Math.round((t - offset) * 1000) / 1000), text: words });
    }
    plain.push(words);
  }
  synced.sort((a, b) => a.time - b.time);
  // A stamped file with nothing but empty lines is not worth showing as synced.
  const hasWords = synced.some((l) => l.text);
  return {
    synced: hasWords ? synced : null,
    plain: plain
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim(),
  };
}

/** `Song.lrc` next to `Song.flac` (case-insensitive name match). */
export async function findLrcFile(trackPath: string): Promise<string | null> {
  const dir = path.dirname(trackPath);
  const stem = path.basename(trackPath, path.extname(trackPath)).toLowerCase();
  const entries = await fs.readdir(dir).catch(() => [] as string[]);
  const match = entries.find((e) => path.extname(e).toLowerCase() === '.lrc' && path.basename(e, path.extname(e)).toLowerCase() === stem);
  return match ? path.join(dir, match) : null;
}

const MAX_LYRICS_BYTES = 512 * 1024;

/** Lyrics for a track: a sidecar `.lrc` file first, then the tags' lyrics. */
export async function loadLyrics(trackPath: string, embedded: () => Promise<string | null>): Promise<Lyrics | null> {
  const lrc = await findLrcFile(trackPath);
  if (lrc) {
    const st = await fs.stat(lrc).catch(() => null);
    if (st && st.size <= MAX_LYRICS_BYTES) {
      const parsed = parseLrc(await fs.readFile(lrc, 'utf8'));
      if (parsed.plain) return { ...parsed, source: 'lrc' };
    }
  }
  const text = await embedded();
  if (!text?.trim()) return null;
  const parsed = parseLrc(text);
  return { synced: parsed.synced, plain: parsed.synced ? parsed.plain : text.replace(/\r\n/g, '\n').trim(), source: 'embedded' };
}
