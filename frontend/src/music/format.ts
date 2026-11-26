import type { Album } from './types';

/** 3:07, 1:02:03 */
export function clock(seconds: number | null | undefined): string {
  const s = Math.max(0, Math.floor(seconds ?? 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (n: number) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

/** "42 minutes", "1 hour, 5 minutes" — the way the album header says it. */
export function longDuration(seconds: number): string {
  const total = Math.round(seconds / 60);
  if (total < 1) return `${Math.max(1, Math.round(seconds))} seconds`;
  const h = Math.floor(total / 60);
  const m = total % 60;
  const minutes = `${m} minute${m === 1 ? '' : 's'}`;
  if (!h) return minutes;
  return `${h} hour${h === 1 ? '' : 's'}${m ? `, ${minutes}` : ''}`;
}

export const plural = (n: number, word: string) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;

export const albumKind = (a: Pick<Album, 'kind'>) => (a.kind === 'single' ? 'Single' : a.kind === 'ep' ? 'EP' : 'Album');

/** A stable hue per id, for placeholder artwork. */
export const hueOf = (key: string | number) => {
  const s = String(key);
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return h;
};
