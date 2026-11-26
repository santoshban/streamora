import type { MediaStreamInfo } from '@streamora/plugin-sdk';
import { primaryStream } from '../media/probe.js';

/** What the browser told us it can play natively (via `canPlayType` / `MediaSource.isTypeSupported`). */
export interface ClientCapabilities {
  /** Containers playable as a plain `<video src>`. */
  containers: string[];
  /** ffprobe codec names: `h264`, `hevc`, `vp9`, `av1`... */
  videoCodecs: string[];
  audioCodecs: string[];
  /** Channels requested for audio produced by the server (HLS). */
  maxAudioChannels: number;
  /** Display and browser handle HDR10/HLG. */
  hdr: boolean;
  maxWidth?: number;
  maxHeight?: number;
  /** The client switches audio tracks inside the file itself (the Android app), so direct play needn't use the default track. */
  selectsAudioTrack?: boolean;
}

export const DEFAULT_CAPABILITIES: ClientCapabilities = {
  containers: ['mp4', 'm4v', 'webm'],
  videoCodecs: ['h264', 'vp8', 'vp9'],
  audioCodecs: ['aac', 'mp3', 'opus', 'vorbis', 'flac'],
  maxAudioChannels: 2,
  hdr: false,
};

export type Quality = 'original' | '2160p' | '1080p' | '720p' | '480p';

export const QUALITIES: Record<Exclude<Quality, 'original'>, { width: number; height: number; bitrate: number }> = {
  '2160p': { width: 3840, height: 2160, bitrate: 25_000_000 },
  '1080p': { width: 1920, height: 1080, bitrate: 8_000_000 },
  '720p': { width: 1280, height: 720, bitrate: 4_000_000 },
  '480p': { width: 854, height: 480, bitrate: 1_500_000 },
};

/** The parts of a `media_files` row the decision needs. */
export interface SourceInfo {
  container: string | null;
  bitrate: number | null;
  durationSeconds: number | null;
  hdr: string | null;
  streams: MediaStreamInfo[];
}

export interface PlaybackDecision {
  method: 'direct' | 'remux' | 'transcode';
  /** Why the file cannot be played as-is (empty for direct play). */
  reasons: string[];
  videoStreamIndex: number | null;
  audioStreamIndex: number | null;
  video: {
    copy: boolean;
    maxWidth: number;
    maxHeight: number;
    bitrate: number;
    tonemap: boolean;
    deinterlace: boolean;
  };
  audio: { copy: boolean; channels: number; bitrate: number };
}

export interface DecisionRequest {
  caps: ClientCapabilities;
  quality: Quality;
  audioStreamIndex?: number;
  preferredAudioLanguage?: string;
  forceTranscode?: boolean;
  /** The container has no keyframe index, so the video stream cannot be copied into HLS. */
  disallowCopy?: boolean;
}

/** ISO 639-1 → 639-2 for the common languages profiles are likely to store. */
const ISO1_TO_2: Record<string, string[]> = {
  en: ['eng'], fr: ['fre', 'fra'], de: ['ger', 'deu'], es: ['spa'], it: ['ita'], pt: ['por'], nl: ['dut', 'nld'],
  ja: ['jpn'], ko: ['kor'], zh: ['chi', 'zho'], ru: ['rus'], sv: ['swe'], da: ['dan'], no: ['nor', 'nob'],
  fi: ['fin'], pl: ['pol'], tr: ['tur'], ar: ['ara'], hi: ['hin'], he: ['heb'], cs: ['cze', 'ces'], el: ['gre', 'ell'],
  hu: ['hun'], th: ['tha'], uk: ['ukr'], vi: ['vie'], id: ['ind'], ro: ['rum', 'ron'],
  te: ['tel'], ta: ['tam'], ml: ['mal'], kn: ['kan'], bn: ['ben'], mr: ['mar'], ur: ['urd'], pa: ['pan'], gu: ['guj'],
};

export function languageMatches(streamLanguage: string | undefined, wanted: string | undefined): boolean {
  if (!streamLanguage || !wanted) return false;
  const w = wanted.toLowerCase().split('-')[0]!;
  const s = streamLanguage.toLowerCase();
  return s === w || (ISO1_TO_2[w]?.includes(s) ?? false);
}

/** Audio track to play: an explicit choice, else the profile's language, else the default/first. */
export function chooseAudioStream(streams: MediaStreamInfo[], requested?: number, preferredLanguage?: string): MediaStreamInfo | undefined {
  const audio = streams.filter((s) => s.type === 'audio');
  if (requested !== undefined) {
    const found = audio.find((s) => s.index === requested);
    if (found) return found;
  }
  if (preferredLanguage) {
    const byLanguage = audio.filter((s) => languageMatches(s.language, preferredLanguage));
    const pick = byLanguage.find((s) => s.default) ?? byLanguage.find((s) => !s.hearingImpaired) ?? byLanguage[0];
    if (pick) return pick;
  }
  return primaryStream(streams, 'audio');
}

function outputAudio(stream: MediaStreamInfo | undefined, caps: ClientCapabilities): PlaybackDecision['audio'] {
  const sourceChannels = stream?.channels ?? 2;
  const channels = Math.max(1, Math.min(sourceChannels, caps.maxAudioChannels >= 6 ? 6 : 2));
  const copy =
    !!stream && stream.codec === 'aac' && sourceChannels <= caps.maxAudioChannels && !/he-?aac/i.test(stream.profile ?? '');
  return { copy, channels, bitrate: channels > 2 ? 384_000 : 192_000 };
}

/** Bitrate for a transcode: the quality preset, or a size-based default for "original". */
function targetBitrate(quality: Quality, height: number, sourceVideoBitrate?: number): number {
  if (quality !== 'original') return QUALITIES[quality].bitrate;
  const table = height >= 1800 ? 25_000_000 : height >= 1000 ? 10_000_000 : height >= 700 ? 5_000_000 : 2_500_000;
  // Re-encoding HEVC/AV1 to H.264 needs more bits, but never more than twice the source.
  return sourceVideoBitrate ? Math.min(table, Math.max(1_500_000, sourceVideoBitrate * 2)) : table;
}

export function decidePlayback(source: SourceInfo, request: DecisionRequest): PlaybackDecision {
  const { caps, quality } = request;
  const video = source.streams.find((s) => s.type === 'video');
  const audio = chooseAudioStream(source.streams, request.audioStreamIndex, request.preferredAudioLanguage);
  const browserDefaultAudio = primaryStream(source.streams, 'audio');

  const reasons: string[] = [];
  const width = video?.width ?? 0;
  const height = video?.height ?? 0;

  const box = { width: Number.MAX_SAFE_INTEGER, height: Number.MAX_SAFE_INTEGER };
  if (quality !== 'original') Object.assign(box, { width: QUALITIES[quality].width, height: QUALITIES[quality].height });
  if (caps.maxWidth) box.width = Math.min(box.width, caps.maxWidth);
  if (caps.maxHeight) box.height = Math.min(box.height, caps.maxHeight);

  // ── reasons the video stream itself can't be sent as-is ──
  const videoReasons: string[] = [];
  if (!video) videoReasons.push('no video stream');
  else {
    if (!caps.videoCodecs.includes(video.codec)) videoReasons.push(`video codec ${video.codec} is not supported by this browser`);
    if (video.codec === 'h264' && (video.bitDepth ?? 8) > 8) videoReasons.push('10-bit H.264 is not supported by browsers');
    if (source.hdr && !caps.hdr) videoReasons.push(`${source.hdr} needs tone mapping for this display`);
    if (width > box.width * 1.05 || height > box.height * 1.05) videoReasons.push(`resolution above ${quality === 'original' ? 'device limit' : quality}`);
    if (quality !== 'original' && source.bitrate && source.bitrate > QUALITIES[quality].bitrate * 1.5) {
      videoReasons.push(`bitrate above ${quality}`);
    }
  }
  if (request.forceTranscode) videoReasons.push('transcoding requested');

  // ── direct play ──
  const containerOk =
    !!source.container &&
    (caps.containers.includes(source.container) || (source.container === 'm4v' && caps.containers.includes('mp4')));
  if (!containerOk) reasons.push(`container ${source.container ?? 'unknown'} is not supported by this browser`);
  if (audio && !caps.audioCodecs.includes(audio.codec)) reasons.push(`audio codec ${audio.codec} is not supported by this browser`);
  if (audio && browserDefaultAudio && audio.index !== browserDefaultAudio.index && !caps.selectsAudioTrack) {
    reasons.push('selected audio track is not the default track');
  }
  reasons.push(...videoReasons);

  const base = { videoStreamIndex: video?.index ?? null, audioStreamIndex: audio?.index ?? null };
  const hlsAudio = outputAudio(audio, caps);

  if (reasons.length === 0) {
    return {
      method: 'direct',
      reasons,
      ...base,
      video: { copy: true, maxWidth: width, maxHeight: height, bitrate: source.bitrate ?? 0, tonemap: false, deinterlace: false },
      audio: { copy: true, channels: audio?.channels ?? 2, bitrate: 0 },
    };
  }

  // ── remux: H.264 8-bit copied into HLS (container/audio were the only problems) ──
  if (request.disallowCopy && videoReasons.length === 0) reasons.push('no keyframe index for stream copy');
  const canCopyVideo =
    !request.disallowCopy &&
    !!video &&
    videoReasons.length === 0 &&
    video.codec === 'h264' &&
    caps.videoCodecs.includes('h264') &&
    (video.pixFmt === undefined || /^yuvj?420p$/.test(video.pixFmt));
  const sourceVideoBitrate = video?.bitRate ?? (source.bitrate ? source.bitrate * 0.9 : undefined);

  if (canCopyVideo) {
    return {
      method: 'remux',
      reasons,
      ...base,
      video: { copy: true, maxWidth: width, maxHeight: height, bitrate: sourceVideoBitrate ?? 0, tonemap: false, deinterlace: false },
      audio: hlsAudio,
    };
  }

  const outHeight = Math.min(height || 1080, box.height);
  return {
    method: 'transcode',
    reasons,
    ...base,
    video: {
      copy: false,
      maxWidth: Math.min(width || 1920, box.width),
      maxHeight: outHeight,
      bitrate: targetBitrate(quality, outHeight, sourceVideoBitrate),
      tonemap: !!source.hdr && !caps.hdr,
      deinterlace: video?.interlaced === true,
    },
    audio: hlsAudio,
  };
}

/** Output size after fitting `width×height` into a box, keeping aspect ratio and even dimensions. */
export function fitWithin(width: number, height: number, maxWidth: number, maxHeight: number): { width: number; height: number } {
  if (!width || !height) return { width: maxWidth, height: maxHeight };
  const scale = Math.min(1, maxWidth / width, maxHeight / height);
  const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
  return { width: even(width * scale), height: even(height * scale) };
}

/** RFC 6381 codec string for an H.264 stream (`avc1.640029`). */
export function avcCodecString(profile: string | undefined, level: number | undefined): string {
  const p = (profile ?? 'high').toLowerCase();
  const profileHex = p.includes('baseline') ? '42E0' : p === 'main' ? '4D40' : p.includes('high 10') ? '6E00' : '6400';
  const levelHex = Math.max(10, Math.min(62, level && level > 0 ? level : 41))
    .toString(16)
    .toUpperCase()
    .padStart(2, '0');
  return `avc1.${profileHex}${levelHex}`;
}
