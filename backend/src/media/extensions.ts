import path from 'node:path';

export const VIDEO_EXTENSIONS = new Set([
  '.mkv', '.mp4', '.m4v', '.mov', '.avi', '.wmv', '.webm', '.ts', '.m2ts', '.mts',
  '.mpg', '.mpeg', '.flv', '.ogv', '.3gp', '.divx', '.asf',
]);

export const SUBTITLE_EXTENSIONS = new Set(['.srt', '.ass', '.ssa', '.vtt', '.sub', '.idx', '.sup']);
export const METADATA_EXTENSIONS = new Set(['.nfo']);
export const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.tbn']);

/**
 * Folders never scanned: NAS/OS junk and Plex/Jellyfin-style extras folders
 * (trailers, featurettes...) that would otherwise show up as movies or episodes.
 */
const SKIPPED_DIRS = new Set([
  'extras', 'featurettes', 'behind the scenes', 'deleted scenes', 'interviews', 'scenes', 'shorts',
  'trailers', 'other', 'others', 'sample', 'samples', 'bonus', 'bonus features',
  '@eadir', '.@__thumb', '#recycle', '#snapshot', '$recycle.bin', 'system volume information',
  'lost+found', 'video_ts', 'bdmv', 'certificate',
]);

/** A folder containing one of these files (and everything below it) is skipped. */
export const IGNORE_MARKERS = ['.nomedia', '.ignore', '.plexignore', '.streamoraignore'];

// Only `-`/`_` joined suffixes (Plex/Jellyfin convention), so titles such as
// "The Interview" or "The Other" are not mistaken for extras.
const EXTRA_SUFFIX =
  /(?:[-_](?:trailer|featurette|behindthescenes|deleted|deletedscene|interview|scene|short|other|extra)|[-_. ]sample)\d*$/i;

export const extOf = (p: string) => path.extname(p).toLowerCase();
export const isVideoFile = (p: string) => VIDEO_EXTENSIONS.has(extOf(p));
export const isSubtitleFile = (p: string) => SUBTITLE_EXTENSIONS.has(extOf(p));
export const isSidecarMetadataFile = (p: string) => METADATA_EXTENSIONS.has(extOf(p)) || IMAGE_EXTENSIONS.has(extOf(p));

export function isSkippedDir(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.startsWith('.') || SKIPPED_DIRS.has(lower);
}

/** `Movie-trailer.mkv`, `sample.mkv`, `Movie.sample.mkv` ... */
export function isExtraFile(fileName: string): boolean {
  const stem = path.basename(fileName, path.extname(fileName));
  if (/^sample$/i.test(stem) || stem.startsWith('.')) return true;
  return EXTRA_SUFFIX.test(stem);
}

/** True when any folder between `root` (exclusive) and `file` (exclusive) is skipped. */
export function isInSkippedDir(file: string, root: string): boolean {
  const rel = path.relative(root, path.dirname(file));
  if (!rel || rel.startsWith('..')) return false;
  return rel.split(/[\\/]/).some(isSkippedDir);
}
