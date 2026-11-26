import path from 'node:path';
import type { FfprobeResult, MediaStreamInfo, MediaStreamType } from '@streamora/plugin-sdk';

/** Everything the scanner stores about a file's technical properties. */
export interface MediaProbe {
  container: string | null;
  durationSeconds: number | null;
  bitrate: number | null;
  /** Format-level `start_time`; ffmpeg's `-ss` is relative to it. */
  startTimeSeconds: number;
  videoCodec: string | null;
  videoProfile: string | null;
  width: number | null;
  height: number | null;
  frameRate: number | null;
  bitDepth: number | null;
  resolution: string | null;
  hdr: string | null;
  audioCodec: string | null;
  audioChannels: number | null;
  streams: MediaStreamInfo[];
  /**
   * Container and primary audio stream tags with lower-case keys (title, artist,
   * album, track...). Read by the music scanner; video scans ignore them.
   */
  tags?: Record<string, string>;
}

type RawStream = NonNullable<FfprobeResult['streams']>[number];

const num = (v: unknown): number | undefined => {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
};
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined);

function frameRateOf(s: RawStream): number | undefined {
  for (const key of ['avg_frame_rate', 'r_frame_rate']) {
    const raw = str(s[key]);
    if (!raw) continue;
    const [a, b] = raw.split('/').map(Number);
    if (a && b) return Math.round((a / b) * 1000) / 1000;
  }
  return undefined;
}

function bitDepthOf(s: RawStream): number | undefined {
  const raw = num(s.bits_per_raw_sample);
  if (raw && raw >= 8 && raw <= 16) return raw;
  const pix = str(s.pix_fmt);
  if (!pix) return undefined;
  const m = /p(\d{2})(?:le|be)?$/.exec(pix);
  return m ? Number(m[1]) : 8;
}

const LANGUAGE_UNDEFINED = new Set(['und', 'unk', 'unknown', 'mis', 'zxx', '']);

function streamType(s: RawStream): MediaStreamType {
  const type = s.codec_type;
  if (type === 'video') return s.disposition?.attached_pic ? 'attachment' : 'video';
  if (type === 'audio' || type === 'subtitle' || type === 'attachment') return type;
  return 'data';
}

export function normalizeStream(s: RawStream): MediaStreamInfo {
  const type = streamType(s);
  const tags = s.tags ?? {};
  const language = str(tags.language ?? tags.LANGUAGE)?.toLowerCase();
  const title = str(tags.title ?? tags.TITLE);
  const out: MediaStreamInfo = {
    index: s.index,
    type,
    codec: (str(s.codec_name) ?? 'unknown').toLowerCase(),
    language: language && !LANGUAGE_UNDEFINED.has(language) ? language : undefined,
    title,
    default: s.disposition?.default === 1,
    forced: s.disposition?.forced === 1 || /\bforced\b/i.test(title ?? ''),
    hearingImpaired: s.disposition?.hearing_impaired === 1 || /\b(?:sdh|cc|hearing impaired)\b/i.test(title ?? ''),
    profile: str(s.profile),
    bitRate: num(s.bit_rate) ?? num(tags.BPS ?? tags['BPS-eng']),
  };
  if (type === 'video') {
    out.width = num(s.width);
    out.height = num(s.height);
    out.pixFmt = str(s.pix_fmt);
    out.bitDepth = bitDepthOf(s);
    out.frameRate = frameRateOf(s);
    const level = num(s.level);
    if (level !== undefined && level > 0) out.level = level;
    const fieldOrder = str(s.field_order);
    if (fieldOrder) out.interlaced = !['progressive', 'unknown'].includes(fieldOrder);
    out.colorTransfer = str(s.color_transfer);
  } else if (type === 'audio') {
    out.channels = num(s.channels);
    out.channelLayout = str(s.channel_layout);
    out.sampleRate = num(s.sample_rate);
  }
  for (const key of Object.keys(out) as Array<keyof MediaStreamInfo>) if (out[key] === undefined) delete out[key];
  if (!out.default) delete out.default;
  if (!out.forced) delete out.forced;
  if (!out.hearingImpaired) delete out.hearingImpaired;
  return out;
}

/** Short container name from ffprobe's `format_name` (refined by the file extension). */
export function containerOf(formatName: string | undefined, filePath: string): string | null {
  const ext = path.extname(filePath).toLowerCase().slice(1);
  const f = (formatName ?? '').toLowerCase();
  if (f.includes('matroska') || f.includes('webm')) return ext === 'webm' ? 'webm' : 'mkv';
  if (f.includes('mp4') || f.includes('mov')) return ext === 'mov' ? 'mov' : ext === 'm4v' ? 'm4v' : 'mp4';
  if (f.startsWith('avi')) return 'avi';
  if (f === 'mpegts') return ext === 'm2ts' || ext === 'mts' ? 'm2ts' : 'ts';
  if (f === 'asf') return 'wmv';
  if (f === 'flv') return 'flv';
  if (f.startsWith('mpeg')) return 'mpg';
  if (f === 'ogg') return 'ogv';
  return f.split(',')[0] || ext || null;
}

/** Plex-style resolution label. Width wins so 1920×800 scope films still read as 1080p. */
export function resolutionLabel(width?: number | null, height?: number | null): string | null {
  const w = width ?? 0;
  const h = height ?? 0;
  if (!w && !h) return null;
  if (w >= 3200 || h >= 1800) return '4K';
  if (w >= 1800 || h >= 1000) return '1080p';
  if (w >= 1200 || h >= 700) return '720p';
  if (h >= 470 || w >= 840) return '480p';
  return 'SD';
}

function hdrOf(raw: RawStream | undefined, stream: MediaStreamInfo | undefined): string | null {
  if (!raw || !stream) return null;
  const sideData = Array.isArray(raw.side_data_list) ? (raw.side_data_list as Array<Record<string, unknown>>) : [];
  const tag = str(raw.codec_tag_string)?.toLowerCase();
  if (sideData.some((d) => /dovi|dolby vision/i.test(String(d.side_data_type ?? ''))) || tag === 'dvhe' || tag === 'dvh1') {
    return 'DV';
  }
  if (sideData.some((d) => /2094-40|hdr10\+/i.test(String(d.side_data_type ?? '')))) return 'HDR10+';
  if (stream.colorTransfer === 'smpte2084') return 'HDR10';
  if (stream.colorTransfer === 'arib-std-b67') return 'HLG';
  return null;
}

/** Picks the stream a player would choose by default: the `default` one, else the first. */
export function primaryStream(streams: MediaStreamInfo[], type: 'video' | 'audio'): MediaStreamInfo | undefined {
  const ofType = streams.filter((s) => s.type === type);
  return ofType.find((s) => s.default) ?? ofType[0];
}

/** Format tags win over stream tags; Ogg/Opus files keep theirs on the audio stream only. */
export function mergedTags(result: FfprobeResult, audioIndex?: number): Record<string, string> {
  const out: Record<string, string> = {};
  const add = (tags: Record<string, string> | undefined) => {
    for (const [k, v] of Object.entries(tags ?? {})) {
      const key = k.toLowerCase();
      if (typeof v === 'string' && v.trim() !== '' && !(key in out)) out[key] = v.trim();
    }
  };
  add(result.format?.tags);
  add(result.streams?.find((s) => s.index === audioIndex)?.tags);
  return out;
}

export function normalizeProbe(result: FfprobeResult, filePath: string): MediaProbe {
  const rawStreams = Array.isArray(result.streams) ? result.streams : [];
  const streams = rawStreams.map(normalizeStream);
  const format = result.format ?? {};

  const video = streams.find((s) => s.type === 'video');
  const rawVideo = video ? rawStreams.find((s) => s.index === video.index) : undefined;
  const audio = primaryStream(streams, 'audio');

  const streamDurations = rawStreams.map((s) => num(s.duration)).filter((d): d is number => d !== undefined && d > 0);
  const duration = num(format.duration) ?? (streamDurations.length ? Math.max(...streamDurations) : undefined);

  return {
    container: containerOf(format.format_name, filePath),
    durationSeconds: duration && duration > 0 ? Math.round(duration * 1000) / 1000 : null,
    bitrate: num(format.bit_rate) ?? null,
    startTimeSeconds: Math.max(0, num(format.start_time) ?? 0),
    videoCodec: video?.codec ?? null,
    videoProfile: video?.profile ?? null,
    width: video?.width ?? null,
    height: video?.height ?? null,
    frameRate: video?.frameRate ?? null,
    bitDepth: video?.bitDepth ?? null,
    resolution: resolutionLabel(video?.width, video?.height),
    hdr: hdrOf(rawVideo, video),
    audioCodec: audio?.codec ?? null,
    audioChannels: audio?.channels ?? null,
    streams,
    tags: mergedTags(result, audio?.index),
  };
}
