export function formatClock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const s = Math.floor(seconds % 60);
  const m = Math.floor((seconds / 60) % 60);
  const h = Math.floor(seconds / 3600);
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

export function formatRuntime(minutes: number | null | undefined): string | null {
  if (!minutes) return null;
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return h ? `${h}h ${m}m` : `${m}m`;
}

export function formatBytes(bytes: number): string {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** i).toFixed(i >= 3 ? 1 : 0)} ${units[i]}`;
}

export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return 'never';
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.round(diff / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return days < 30 ? `${days} d ago` : new Date(iso).toLocaleDateString();
}

export const channelLabel = (n: number | null | undefined) =>
  !n ? '' : n === 1 ? 'Mono' : n === 2 ? 'Stereo' : n === 6 ? '5.1' : n === 8 ? '7.1' : `${n} ch`;

const languageNames = typeof Intl !== 'undefined' && 'DisplayNames' in Intl ? new Intl.DisplayNames(['en'], { type: 'language' }) : null;
const ISO2_TO_1: Record<string, string> = {
  eng: 'en', fre: 'fr', fra: 'fr', ger: 'de', deu: 'de', spa: 'es', ita: 'it', por: 'pt', jpn: 'ja', kor: 'ko', chi: 'zh',
  zho: 'zh', rus: 'ru', hin: 'hi', tel: 'te', tam: 'ta', mal: 'ml', kan: 'kn', ben: 'bn', mar: 'mr', urd: 'ur', ara: 'ar',
  dut: 'nl', nld: 'nl', swe: 'sv', dan: 'da', nor: 'no', fin: 'fi', pol: 'pl', tur: 'tr', heb: 'he', tha: 'th', vie: 'vi',
  ind: 'id', gre: 'el', ell: 'el', cze: 'cs', ces: 'cs', hun: 'hu', rum: 'ro', ron: 'ro', ukr: 'uk',
};

/** `eng` / `en` / `pt-BR` → "English" / "Portuguese (Brazil)". */
export function languageName(code: string | null | undefined): string {
  if (!code) return 'Unknown';
  const normalized = ISO2_TO_1[code.toLowerCase()] ?? code;
  try {
    return languageNames?.of(normalized) ?? code;
  } catch {
    return code;
  }
}

/** True when two language codes (ISO 639-1/2, BCP 47) mean the same language. */
export function sameLanguage(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const norm = (c: string) => (ISO2_TO_1[c.toLowerCase()] ?? c.toLowerCase()).split('-')[0];
  return norm(a) === norm(b);
}
