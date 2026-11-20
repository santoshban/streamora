import path from 'node:path';
import type { FileEntry, PluginFileSystem, SubtitleFileContext, SubtitleTrack } from '@streamora/plugin-sdk';
import type { TextSubtitleFormat } from './convert.js';
import { languageName, normalizeLanguage } from './languages.js';

export const SUBTITLE_EXTENSIONS: Record<string, TextSubtitleFormat> = {
  '.srt': 'srt',
  '.vtt': 'vtt',
  '.ass': 'ass',
  '.ssa': 'ssa',
};

export interface SidecarInfo {
  language?: string;
  label?: string;
  forced: boolean;
  hearingImpaired: boolean;
  default: boolean;
}

const stemOf = (file: string) => path.basename(file, path.extname(file));
const lower = (s: string) => s.toLowerCase();

/**
 * Reads language and flags from a subtitle file name:
 * `Movie.en.srt`, `Movie.eng.forced.srt`, `Movie.English.SDH.srt`,
 * `Movie.pt-BR.srt`, `Subs/Movie/2_English.srt`.
 */
export function parseSidecarName(fileName: string, videoStem: string | null): SidecarInfo {
  let rest = stemOf(fileName);
  if (videoStem && lower(rest).startsWith(lower(videoStem))) rest = rest.slice(videoStem.length);

  const info: SidecarInfo = { forced: false, hearingImpaired: false, default: false };
  const unknown: string[] = [];

  for (const token of rest.split(/[.\s_]+/).filter(Boolean)) {
    const t = lower(token).replace(/^[\[(]|[\])]$/g, '');
    if (/^\d+$/.test(t)) continue; // "2_English" ordering prefixes
    if (t === 'forced' || t === 'foreign') {
      info.forced = true;
      continue;
    }
    if (t === 'sdh' || t === 'hoh' || ((t === 'hi' || t === 'cc') && info.language)) {
      info.hearingImpaired = true;
      continue;
    }
    if (t === 'default') {
      info.default = true;
      continue;
    }
    const language = !info.language ? normalizeLanguage(t) : undefined;
    if (language) {
      info.language = language;
      // Keep regional variants visible: pt-BR, es-419, zh-Hant...
      if (/^[a-z]{2,3}-[a-z0-9]{2,4}$/i.test(token)) unknown.push(token);
      continue;
    }
    unknown.push(token);
  }

  const parts = [languageName(info.language), ...unknown].filter(Boolean);
  const flags = [info.forced ? 'Forced' : '', info.hearingImpaired ? 'SDH' : ''].filter(Boolean);
  const label = [parts.join(' '), flags.length ? `(${flags.join(', ')})` : ''].filter(Boolean).join(' ');
  if (label) info.label = label;
  return info;
}

const norm = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p);

async function safeList(fs: PluginFileSystem, dir: string): Promise<FileEntry[]> {
  try {
    return await fs.list(dir);
  } catch {
    return [];
  }
}

const isSubtitle = (e: FileEntry) => e.isFile && path.extname(e.name).toLowerCase() in SUBTITLE_EXTENSIONS;

/** Finds external subtitle files that belong to `file`. */
export async function findSidecars(
  fs: PluginFileSystem,
  file: SubtitleFileContext,
  folderNames: string[],
): Promise<SubtitleTrack[]> {
  const dir = path.dirname(file.path);
  const videoStem = stemOf(file.path);
  const videoStemLower = lower(videoStem);
  // Loose files like "English.srt" only belong to us if we're the only video in the folder.
  const dedicated = file.siblingVideoPaths.filter((p) => norm(path.dirname(p)) === norm(dir)).length <= 1;
  const wantedFolders = new Set(folderNames.map(lower));

  const found = new Map<string, { entry: FileEntry; stem: string | null }>();
  const add = (entry: FileEntry, stem: string | null) => {
    if (!found.has(norm(entry.path))) found.set(norm(entry.path), { entry, stem });
  };

  const entries = await safeList(fs, dir);
  for (const entry of entries) {
    if (isSubtitle(entry)) {
      if (lower(entry.name).startsWith(`${videoStemLower}.`) || lower(entry.name).startsWith(`${videoStemLower}_`)) add(entry, videoStem);
      else if (dedicated) add(entry, null);
      continue;
    }
    if (!entry.isDirectory || !wantedFolders.has(lower(entry.name))) continue;

    // Subs/<file>.en.srt, Subs/English.srt (dedicated folders) and Subs/<video stem>/2_English.srt
    for (const sub of await safeList(fs, entry.path)) {
      if (isSubtitle(sub)) {
        if (lower(sub.name).startsWith(videoStemLower)) add(sub, videoStem);
        else if (dedicated) add(sub, null);
      } else if (sub.isDirectory && lower(sub.name) === videoStemLower) {
        for (const nested of await safeList(fs, sub.path)) if (isSubtitle(nested)) add(nested, null);
      }
    }
  }

  return [...found.values()].map(({ entry, stem }) => {
    const info = parseSidecarName(entry.name, stem);
    return {
      source: 'sidecar' as const,
      path: entry.path,
      codec: SUBTITLE_EXTENSIONS[path.extname(entry.name).toLowerCase()]!,
      language: info.language,
      label: info.label,
      forced: info.forced,
      hearingImpaired: info.hearingImpaired,
      default: info.default,
      renderable: true,
    };
  });
}
