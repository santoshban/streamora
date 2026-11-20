import { encoderUploadFilters, hardwareInputArgs, type VideoEncoder } from './encoders.js';
import { segmentCount, type SegmentPlan } from './segments.js';

/*
 * Builds the ffmpeg command for one "run": segments [start, end) of a plan.
 *
 * Every run must cut byte-for-byte compatible segments, whatever segment it
 * starts at. The rules (verified against ffmpeg 6–9):
 *   - input-seek with `-ss`, then `-output_ts_offset` with the same value puts
 *     timestamps back on the absolute media timeline;
 *   - `-segment_times` are relative to the run start (before the offset);
 *   - `-avoid_negative_ts disabled` (on the segment muxer *and* on the MPEG-TS
 *     muxer it creates per file) stops B-frame / AAC-priming shifts that would
 *     otherwise move the first segment of a file by a frame or two;
 *   - stream copy: ffmpeg backs `-ss` off by 3/23 s for B-frame video, so we
 *     seek a little past the keyframe and use `-noaccurate_seek` so audio is
 *     not trimmed to that later point.
 */

/** Past the 3/23 s (≈0.13 s) back-off ffmpeg applies to `-ss` for B-frame video. */
const COPY_SEEK_NUDGE = 0.15;
/** Split slightly before each keyframe so timestamp rounding can never skip it. */
const COPY_SPLIT_TOLERANCE = 0.03;
const GRID_SPLIT_TOLERANCE = 0.001;
/** Run past the last segment so it is closed by a split; the extra partial segment is ignored. */
const RUN_OVERSHOOT = 1;

export type VideoOutput =
  | { copy: true }
  | {
      copy: false;
      encoder: VideoEncoder;
      maxWidth: number;
      maxHeight: number;
      /** Target peak bitrate, bits/s. */
      bitrate: number;
      tonemap: boolean;
      deinterlace: boolean;
      /** H.264 level, e.g. `4.1`. */
      level: string;
    };

export interface AudioOutput {
  copy: boolean;
  channels: number;
  /** bits/s, used when encoding. */
  bitrate: number;
}

export interface RunSpec {
  input: string;
  plan: SegmentPlan;
  start: number;
  end: number;
  videoStreamIndex: number;
  audioStreamIndex: number | null;
  video: VideoOutput;
  audio: AudioOutput;
  /** `…/r3-%d.ts` */
  outputPattern: string;
  /** CSV list ffmpeg appends to as each segment completes. */
  listFile: string;
  vaapiDevice: string;
  segmentSeconds: number;
}

const fmt = (n: number) => (Math.round(n * 1000) / 1000).toFixed(3);

export function videoFilters(video: Extract<VideoOutput, { copy: false }>): string {
  const filters: string[] = [];
  if (video.deinterlace) filters.push('yadif=mode=send_frame:parity=auto:deint=interlaced');
  filters.push(
    `scale=w='min(iw,${video.maxWidth})':h='min(ih,${video.maxHeight})':force_original_aspect_ratio=decrease:force_divisible_by=2`,
  );
  if (video.tonemap) {
    filters.push(
      'zscale=t=linear:npl=100',
      'format=gbrpf32le',
      'zscale=p=bt709',
      'tonemap=tonemap=hable:desat=0',
      'zscale=t=bt709:m=bt709:r=tv',
    );
  }
  filters.push(...encoderUploadFilters(video.encoder.kind));
  return filters.join(',');
}

function encoderArgs(video: Extract<VideoOutput, { copy: false }>): string[] {
  const b = String(Math.round(video.bitrate));
  const buf = String(Math.round(video.bitrate * 2));
  switch (video.encoder.kind) {
    case 'nvenc':
      return ['-c:v', 'h264_nvenc', '-preset', 'p4', '-rc', 'vbr', '-cq', '23', '-b:v', b, '-maxrate', b, '-bufsize', buf,
        '-profile:v', 'high', '-forced-idr', '1'];
    case 'qsv':
      return ['-c:v', 'h264_qsv', '-preset', 'veryfast', '-b:v', b, '-maxrate', b, '-bufsize', buf, '-profile:v', 'high',
        '-forced_idr', '1'];
    case 'vaapi':
      return ['-c:v', 'h264_vaapi', '-rc_mode', 'VBR', '-b:v', b, '-maxrate', b, '-bufsize', buf, '-profile:v', 'high'];
    case 'videotoolbox':
      return ['-c:v', 'h264_videotoolbox', '-b:v', b, '-maxrate', b, '-bufsize', buf, '-profile:v', 'high', '-realtime', '1'];
    default:
      return ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-maxrate', b, '-bufsize', buf,
        '-profile:v', 'high', '-level:v', video.level];
  }
}

export function buildRunArgs(spec: RunSpec): string[] {
  const { plan, start, video } = spec;
  const count = segmentCount(plan);
  const end = Math.min(spec.end, count);
  const startTime = plan.starts[start]!;
  const seek = start === 0 ? 0 : video.copy ? startTime + COPY_SEEK_NUDGE : startTime;
  const tolerance = video.copy ? COPY_SPLIT_TOLERANCE : GRID_SPLIT_TOLERANCE;

  // Split points (relative to the run start), including the one closing segment end-1.
  const splits: string[] = [];
  for (let j = start + 1; j <= end && j < count; j++) splits.push(fmt(Math.max(0.001, plan.starts[j]! - seek - tolerance)));

  const args = ['-hide_banner', '-nostdin', '-loglevel', 'error', '-y'];
  // Decoding stays on the CPU: measured on 4K HEVC 10-bit, `-hwaccel auto` was ~2x slower than
  // software decoding because every frame is copied back for the software scaler.
  if (!video.copy) args.push(...hardwareInputArgs(video.encoder.kind, spec.vaapiDevice));
  if (seek > 0) {
    if (video.copy) args.push('-noaccurate_seek');
    args.push('-ss', fmt(seek));
  }
  args.push('-i', spec.input);

  args.push('-map', `0:${spec.videoStreamIndex}`);
  if (spec.audioStreamIndex !== null) args.push('-map', `0:${spec.audioStreamIndex}`);
  args.push('-map_metadata', '-1', '-map_chapters', '-1', '-sn', '-dn');

  if (video.copy) {
    args.push('-c:v', 'copy');
  } else {
    args.push(...encoderArgs(video), '-vf', videoFilters(video));
    args.push('-force_key_frames', `expr:gte(t,n_forced*${spec.segmentSeconds})`);
  }

  if (spec.audioStreamIndex !== null) {
    if (spec.audio.copy) args.push('-c:a', 'copy');
    else args.push('-c:a', 'aac', '-ac', String(spec.audio.channels), '-b:a', String(spec.audio.bitrate));
  }

  args.push('-avoid_negative_ts', 'disabled', '-max_muxing_queue_size', '4096');
  if (end < count) args.push('-t', fmt(plan.starts[end]! - seek + RUN_OVERSHOOT));
  if (seek > 0) args.push('-output_ts_offset', fmt(seek));

  args.push('-f', 'segment', '-segment_format', 'mpegts', '-segment_format_options', 'avoid_negative_ts=disabled');
  if (splits.length) args.push('-segment_times', splits.join(','));
  args.push(
    '-segment_start_number', String(start),
    '-segment_list', spec.listFile,
    '-segment_list_type', 'csv',
    spec.outputPattern,
  );
  return args;
}
