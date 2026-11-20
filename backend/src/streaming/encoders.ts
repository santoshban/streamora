import type { AppConfig } from '../config.js';
import type { Logger } from '../lib/logger.js';
import { runProcess } from '../lib/process.js';

export type HardwareKind = 'nvenc' | 'qsv' | 'vaapi' | 'videotoolbox';

export interface VideoEncoder {
  kind: 'software' | HardwareKind;
  /** ffmpeg encoder name, e.g. `libx264`, `h264_nvenc`. */
  name: string;
}

export interface FfmpegFeatures {
  encoder: VideoEncoder;
  /** zscale + tonemap filters are available: HDR sources can be tone-mapped to SDR. */
  tonemap: boolean;
}

const SOFTWARE: VideoEncoder = { kind: 'software', name: 'libx264' };

const HW_ENCODERS: Record<HardwareKind, string> = {
  nvenc: 'h264_nvenc',
  qsv: 'h264_qsv',
  vaapi: 'h264_vaapi',
  videotoolbox: 'h264_videotoolbox',
};

/** Input-side options that make a hardware encoder usable. */
export function hardwareInputArgs(kind: VideoEncoder['kind'], vaapiDevice: string): string[] {
  if (kind === 'vaapi') return ['-vaapi_device', vaapiDevice];
  if (kind === 'qsv') return ['-init_hw_device', 'qsv=hw', '-filter_hw_device', 'hw'];
  return [];
}

/** Final filters converting software frames into what the encoder accepts. */
export function encoderUploadFilters(kind: VideoEncoder['kind']): string[] {
  if (kind === 'vaapi') return ['format=nv12', 'hwupload'];
  if (kind === 'qsv') return ['format=nv12'];
  return ['format=yuv420p'];
}

function autoCandidates(): HardwareKind[] {
  if (process.platform === 'darwin') return ['videotoolbox'];
  if (process.platform === 'win32') return ['nvenc', 'qsv'];
  return ['nvenc', 'vaapi', 'qsv'];
}

/**
 * Resolves which H.264 encoder transcodes use. Hardware encoders are listed in
 * most ffmpeg builds even without the matching GPU, so each candidate is
 * verified with a tiny test encode. Detection runs once, on first use.
 */
export class EncoderSelector {
  private pending?: Promise<FfmpegFeatures>;
  private broken = new Set<string>();

  constructor(
    private readonly media: AppConfig['media'],
    private readonly log: Logger,
  ) {}

  features(): Promise<FfmpegFeatures> {
    this.pending ??= this.detect();
    return this.pending;
  }

  /** Called when a hardware encoder fails at runtime: later sessions use software. */
  markBroken(encoder: VideoEncoder): void {
    if (encoder.kind === 'software' || this.broken.has(encoder.name)) return;
    this.broken.add(encoder.name);
    this.log.warn({ encoder: encoder.name }, 'Hardware encoder failed; falling back to libx264');
    this.pending = this.features().then((f) => ({ ...f, encoder: SOFTWARE }));
  }

  private async testEncoder(kind: HardwareKind): Promise<boolean> {
    const name = HW_ENCODERS[kind];
    const args = [
      '-hide_banner', '-nostdin', '-loglevel', 'error',
      ...hardwareInputArgs(kind, this.media.vaapiDevice),
      '-f', 'lavfi', '-i', 'color=c=black:s=320x240:r=25:d=0.2',
      '-vf', encoderUploadFilters(kind).join(','),
      '-frames:v', '3', '-c:v', name, '-f', 'null', '-',
    ];
    try {
      const { code, stderr } = await runProcess(this.media.ffmpegPath, args, { timeoutMs: 20_000 });
      if (code !== 0) this.log.debug({ encoder: name, stderr: stderr.trim().slice(0, 300) }, 'Hardware encoder unavailable');
      return code === 0;
    } catch {
      return false;
    }
  }

  private async hasTonemap(): Promise<boolean> {
    try {
      const { stdout } = await runProcess(this.media.ffmpegPath, ['-hide_banner', '-filters'], { timeoutMs: 15_000 });
      const text = stdout.toString('utf8');
      return /\szscale\s/.test(text) && /\stonemap\s/.test(text);
    } catch {
      return false;
    }
  }

  private async detect(): Promise<FfmpegFeatures> {
    const tonemap = await this.hasTonemap();
    const setting = this.media.hwAccel;
    const candidates = setting === 'none' ? [] : setting === 'auto' ? autoCandidates() : [setting];

    let encoder = SOFTWARE;
    for (const kind of candidates) {
      if (await this.testEncoder(kind)) {
        encoder = { kind, name: HW_ENCODERS[kind] };
        break;
      }
      if (setting !== 'auto') this.log.warn({ hwAccel: setting }, 'Configured hardware encoder does not work; using libx264');
    }
    this.log.info({ encoder: encoder.name, tonemap }, 'Transcoder ready');
    return { encoder, tonemap };
  }
}
